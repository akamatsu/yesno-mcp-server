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