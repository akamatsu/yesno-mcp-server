// server.js
// YesNo MCP Server — crypto-random yes/no + MCP(Streamable HTTP via SSE)
// v2.2.0: CORS preflight (OPTIONS), endpoint absolute URL, initialize(), fast keep-alive, flushHeaders
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

// CORS: 明示的なプリフライト対応（重要）
const corsOptions = {
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  maxAge: 600, // 秒: プリフライト結果を10分キャッシュ
};
app.options("*", cors(corsOptions)); // すべてのルートでOPTIONSを許可
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

app.get("/", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "YesNo MCP Server",
    version: "2.2.0",
    mode: "crypto-random",
    transport: "streamable-http (SSE + JSON-RPC)",
    endpoints: {
      "/healthz": "GET — health check",
      "/yes": 'GET — returns {"answer":"yes"}',
      "/no": 'GET — returns {"answer":"no"}',
      "/answer?prompt=...":
        'GET — returns {"answer":"yes"|"no"} (cryptographically random; prompt ignored)',
      "/sse": "GET — MCP connection stream (SSE). Emits `endpoint`.",
      "/mcp": "POST — MCP JSON-RPC endpoint (initialize / tools.list / tools.call)",
    },
    env: {
      PORT: process.env.PORT || 3000,
      NODE_ENV: process.env.NODE_ENV || "development",
      CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || origin,
    },
  });
});

app.get("/yes", (_req, res) => res.json({ answer: "yes" }));
app.get("/no", (_req, res) => res.json({ answer: "no" }));
app.get("/answer", (req, res) => {
  const prompt = (req.query.prompt || "").toString();
  res.json({ answer: yesNoRandom(), prompt });
});

// ---------- MCP: SSE (announce JSON-RPC POST endpoint) ----------
app.get("/sse", (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // すぐにヘッダーを送出（Renderのバッファ遅延対策）
  if (res.flushHeaders) res.flushHeaders();

  // 絶対URLのエンドポイント（PUBLIC_BASE_URLがあれば優先）
  const base =
    process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const endpointEvent = {
    uri: `${base}/mcp`,
    protocol: "jsonrpc-2.0",
    version: "2025-03-26",
  };

  // 必須: endpoint イベントを即送信
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify(endpointEvent)}\n\n`);

  // keep-alive（短めにしてプロキシ越しでも安定させる）
  const keepAlive = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    try {
      res.end();
    } catch (_) {}
  });
});

// ---------- JSON-RPC helpers ----------
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---------- MCP: JSON-RPC (/mcp) ----------
// Supports: initialize, ping, tools/list, tools/call
app.post("/mcp", (req, res) => {
  const body = req.body;
  const now = Date.now();

  const requests = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of requests) {
    const { id = null, method, params } = msg || {};
    if (!method) {
      responses.push(rpcError(id, -32600, "Invalid Request"));
      continue;
    }

    if (method === "ping") {
      responses.push(rpcResult(id, { pong: now }));
      continue;
    }

    // クライアントが最初に呼ぶことが多い
    if (method === "initialize") {
      responses.push(
        rpcResult(id, {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "yesno-mcp", version: "2.2.0" },
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
              input_schema: {
                type: "object",
                properties: {
                  prompt: {
                    type: "string",
                    description:
                      "Any question or text (ignored for randomness).",
                  },
                },
                required: ["prompt"],
                additionalProperties: false,
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

  res.json(Array.isArray(body) ? responses : responses[0]);
});

// ---------- 404 fallback ----------
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// ---------- Start ----------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(
    `✅ YesNo MCP Server v2.2.0 (SSE+JSON-RPC, crypto-random, CORS preflight) listening on ${PORT}`
  );
});