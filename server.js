// server.js
// YesNo MCP Server — crypto-random yes/no + MCP(Streamable HTTP via SSE)
// v2.8.0: FIX: Change input_schema to inputSchema (camelCase per MCP spec),
//         support MCP protocol version 2025-06-18, fix notification handling,
//         request logging, POST / endpoint for ChatGPT
"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { randomInt } = require("crypto");

const app = express();

// ---------- Middleware ----------
app.use(helmet());
app.use(express.json({ limit: "256kb" }));

// CORS: 明示プリフライト（重要）
const corsOptions = {
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  maxAge: 600,
};
app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ---------- Utility ----------
function yesNoRandom() {
  return randomInt(0, 2) === 0 ? "yes" : "no";
}

// ---------- Health & simple REST ----------
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ChatGPT MCP client sometimes POSTs /healthz first — handle it gracefully
app.post("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", method: "POST", uptime: process.uptime() });
});

// ルートパス: GET はサーバー情報、POST はMCP JSON-RPC処理（ChatGPT互換性）
app.get("/", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "YesNo MCP Server",
    version: "2.8.0",
    mode: "crypto-random",
    transport: "streamable-http (POST /)",
    endpoints: {
      "/": "POST — MCP JSON-RPC endpoint (ChatGPT compatible)",
      "/healthz": "GET — health check",
      "/yes": 'GET — returns {"answer":"yes"}',
      "/no": 'GET — returns {"answer":"no"}',
      "/answer?prompt=...":
        'GET — returns {"answer":"yes"|"no"} (cryptographically random; prompt ignored)',
      "/sse": "GET — MCP connection stream (SSE, legacy). Emits `endpoint` (plain URL).",
      "/mcp": "POST — Streamable HTTP transport (JSON-RPC)",
    },
    env: {
      PORT: process.env.PORT || 3000,
      NODE_ENV: process.env.NODE_ENV || "development",
      CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || origin,
    },
  });
});

// ルートパスでMCP JSON-RPC処理を受け付ける（ChatGPT互換性）
app.post("/", (req, res) => {
  // デバッグ用ログ
  console.log("=== POST / received ===");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("=======================");

  const result = handleMcp(req, res);

  console.log("=== Response sent ===");
  console.log("Status:", res.statusCode);
  console.log("=====================");

  return result;
});

app.get("/yes", (_req, res) => res.json({ answer: "yes" }));
app.get("/no", (_req, res) => res.json({ answer: "no" }));
app.get("/answer", (req, res) => {
  const prompt = (req.query.prompt || "").toString();
  res.json({ answer: yesNoRandom(), prompt });
});

// ---------- MCP: SSE handlers ----------
// 旧HTTP+SSE transport用（/sse用、endpointイベントを送信）
function handleSSE_Legacy(req, res) {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");

  // すぐに送出（Renderのバッファ遅延対策）
  if (res.flushHeaders) res.flushHeaders();

  // 絶対URLを生成（PUBLIC_BASE_URLがあれば優先）
  const base =
    process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const endpointUri = `${base}/mcp`; // ← プレーンURL文字列

  // クライアントは data を URL 文字列として期待する実装があるため JSON では送らない
  res.write(`event: endpoint\n`);
  res.write(`data: ${endpointUri}\n\n`);

  // 一部クライアントの取りこぼし対策（任意）：同じ内容をもう一度送る
  res.write(`event: endpoint\n`);
  res.write(`data: ${endpointUri}\n\n`);

  // 短めのKeep-alive（プロキシ越し対策）
  const keepAlive = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    try {
      res.end();
    } catch (_) {}
  });
}

// 新Streamable HTTP transport用（/mcp GET用、endpointイベントは送らない）
function handleSSE_Streamable(req, res) {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");

  // すぐに送出（Renderのバッファ遅延対策）
  if (res.flushHeaders) res.flushHeaders();

  // Streamable HTTP transportではendpointイベントは送らず、keep-aliveのみ
  // サーバーからの通知がある場合のみJSON-RPCメッセージを送信
  const keepAlive = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    try {
      res.end();
    } catch (_) {}
  });
}

// 旧SSEエンドポイント（互換性維持、末尾スラッシュあり/なし両対応）
app.get("/sse", handleSSE_Legacy);
app.get("/sse/", handleSSE_Legacy);

// ---------- JSON-RPC helpers ----------
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// 共有ハンドラ：/mcp と /sse(POST) の両方から呼ぶ
function handleMcp(req, res) {
  const body = req.body;
  const now = Date.now();

  const requests = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of requests) {
    const { id = null, method, params } = msg || {};

    // idがnullまたはundefinedの場合はnotification（レスポンス不要）
    const isNotification = id === null || id === undefined;

    if (!method) {
      if (!isNotification) {
        responses.push(rpcError(id, -32600, "Invalid Request"));
      }
      continue;
    }

    // notifications/initialized などの通知は無視（レスポンス不要）
    if (isNotification) {
      console.log(`  [Notification] ${method} - no response needed`);
      continue;
    }

    if (method === "ping") {
      responses.push(rpcResult(id, { pong: now }));
      continue;
    }

    if (method === "initialize") {
      // クライアントが要求するprotocolVersionを確認
      const requestedVersion = params?.protocolVersion || "2025-03-26";
      // サポートするバージョン（最新を優先）
      const supportedVersions = ["2025-06-18", "2025-03-26"];
      // クライアントが要求したバージョンをサポートしているか確認
      const useVersion = supportedVersions.includes(requestedVersion)
        ? requestedVersion
        : "2025-03-26"; // デフォルトは2025-03-26

      responses.push(
        rpcResult(id, {
          protocolVersion: useVersion,
          serverInfo: { name: "yesno-mcp", version: "2.8.0" },
          capabilities: { tools: { list: true, call: true } },
        })
      );
      continue;
    }

    if (method === "tools/list") {
      responses.push(
        rpcResult(id, {
          tools: [
            {
              name: "yesno",
              description: "Return a cryptographically random yes or no.",
              inputSchema: {
                type: "object",
                properties: {
                  prompt: {
                    type: "string",
                    description:
                      "Any question or text (ignored for randomness).",
                  },
                },
                required: ["prompt"],
              },
            },
          ],
        })
      );
      continue;
    }

    if (method === "tools/call") {
      try {
        const toolName = params?.name;
        if (toolName !== "yesno") {
          responses.push(rpcError(id, -32601, "Unknown tool"));
          continue;
        }
        const prompt = (params?.arguments?.prompt || "").toString();
        const answer = yesNoRandom();

        const contentText = JSON.stringify({ answer, prompt });
        responses.push(
          rpcResult(id, {
            content: [{ type: "text", text: contentText }],
            isError: false,
          })
        );
      } catch (e) {
        responses.push(rpcError(id, -32603, "Internal error"));
      }
      continue;
    }

    responses.push(rpcError(id, -32601, "Method not found"));
  }

  // 純粋なnotificationの場合は202 Acceptedを返す（レスポンスなし）
  if (responses.length === 0) {
    return res.status(202).end();
  }

  res.json(Array.isArray(body) ? responses : responses[0]);
}

// 正式エンドポイント（Streamable HTTP transport: POST のみ、ChatGPT互換性）
// GET は 405 Method Not Allowed を返す（ChatGPT は POST のみ使用するため）
app.get("/mcp", (req, res) => {
  res.status(405).json({ error: "Method Not Allowed", message: "Use POST for JSON-RPC requests" });
});
app.get("/mcp/", (req, res) => {
  res.status(405).json({ error: "Method Not Allowed", message: "Use POST for JSON-RPC requests" });
});
app.post("/mcp", handleMcp); // JSON-RPC処理
app.post("/mcp/", handleMcp);
// 互換：一部クライアントが /sse に POST してくる挙動を吸収
app.post("/sse", handleMcp);
app.post("/sse/", handleMcp);

// ---------- 404 fallback ----------
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// ---------- Start ----------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(
    `✅ YesNo MCP Server v2.8.0 (inputSchema fix - MCP spec compliant) listening on ${PORT}`
  );
});