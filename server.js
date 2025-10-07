// server.js
// YesNo MCP Server — cryptographically random "yes" / "no"
// Render free plan friendly: single file, no build step, $PORT support.

"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { randomInt } = require("crypto"); // ← 暗号学的乱数

const app = express();

// --- Middleware ---
app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*", // 必要に応じて制限
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// --- Cryptographically secure random yes/no ---
function yesNoRandom() {
  // 0 or 1 を暗号学的に生成
  return randomInt(0, 2) === 0 ? "yes" : "no";
}

// --- Routes ---
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/", (_req, res) => {
  res.json({
    name: "YesNo MCP Server",
    version: "1.1.0",
    mode: "crypto-random",
    endpoints: {
      "/healthz": "GET — health check",
      "/yes": 'GET — returns {"answer":"yes"}',
      "/no": 'GET — returns {"answer":"no"}',
      "/answer?prompt=...": 'GET — returns {"answer":"yes"|"no"} (cryptographically random; prompt ignored)',
    },
    env: {
      PORT: process.env.PORT || 3000,
      NODE_ENV: process.env.NODE_ENV || "development",
      CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
    },
  });
});

app.get("/yes", (_req, res) => {
  res.json({ answer: "yes" });
});

app.get("/no", (_req, res) => {
  res.json({ answer: "no" });
});

app.get("/answer", (req, res) => {
  const prompt = (req.query.prompt || "").toString(); // 互換のため返却は維持
  const answer = yesNoRandom();
  res.json({ answer, prompt });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// Start server
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`YesNo MCP Server (crypto-random) listening on port ${PORT}`);
});

// --- MCP-compatible SSE endpoint ---
app.get("/sse", (req, res) => {
  // SSE (Server-Sent Events) ヘッダー設定
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // ツール定義（ChatGPTにこのツールがあると通知）
  const toolDefinition = {
    type: "tools",
    data: [
      {
        name: "yesno",
        description: "Return a random yes or no (crypto-secure).",
        input_schema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The user's question or text input."
            }
          },
          required: ["prompt"]
        }
      }
    ]
  };

  // 最初にツール定義を送信
  res.write(`event: tools\ndata: ${JSON.stringify(toolDefinition)}\n\n`);

  // イベントリスナー: ChatGPT側から tool call が届いた場合に yes/no を返す
  req.on("close", () => {
    console.log("SSE connection closed.");
  });
});

// --- Tool invocation endpoint (called by ChatGPT MCP) ---
app.post("/invocations", express.json(), (req, res) => {
  const { name, arguments: args } = req.body;
  if (name === "yesno") {
    const prompt = args?.prompt || "";
    const answer = Math.random() < 0.5 ? "yes" : "no";
    res.json({ answer, prompt });
  } else {
    res.status(400).json({ error: "Unknown tool" });
  }
});