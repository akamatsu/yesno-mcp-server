// server.js
// YesNo MCP Server — crypto-random yes/no + MCP(SSE) compliant version with flushHeaders
"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { randomInt } = require("crypto");

const app = express();

// --- Middleware setup ---
app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*", // Allow all origins (safe for demo)
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// --- Crypto-random yes/no ---
function yesNoRandom() {
  return randomInt(0, 2) === 0 ? "yes" : "no";
}

// --- Health and simple REST endpoints ---
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/", (_req, res) => {
  res.json({
    name: "YesNo MCP Server",
    version: "1.3.0",
    mode: "crypto-random",
    endpoints: {
      "/healthz": "GET — health check",
      "/yes": 'GET — returns {"answer":"yes"}',
      "/no": 'GET — returns {"answer":"no"}',
      "/answer?prompt=...":
        'GET — returns {"answer":"yes"|"no"} (cryptographically random; prompt ignored)',
      "/sse": "GET — MCP tools discovery via Server-Sent Events",
      "/invocations": "POST — MCP tool invocation endpoint",
    },
    env: {
      PORT: process.env.PORT || 3000,
      NODE_ENV: process.env.NODE_ENV || "development",
      CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
    },
  });
});

app.get("/yes", (_req, res) => res.json({ answer: "yes" }));
app.get("/no", (_req, res) => res.json({ answer: "no" }));
app.get("/answer", (req, res) => {
  const prompt = (req.query.prompt || "").toString();
  res.json({ answer: yesNoRandom(), prompt });
});

// --- MCP (SSE) endpoint ---
app.get("/sse", (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Immediately flush headers to avoid buffering delay (Render timeout fix)
  if (res.flushHeaders) res.flushHeaders();

  // Tool definition event for ChatGPT MCP handshake
  const toolsEvent = {
    type: "tools",
    data: [
      {
        name: "yesno",
        description: "Return a cryptographically random yes or no.",
        input_schema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Any question or text (ignored for randomness).",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        invocation: {
          method: "POST",
          url: "/invocations",
        },
      },
    ],
  };

  // Send tools definition
  res.write(`event: tools\n`);
  res.write(`data: ${JSON.stringify(toolsEvent)}\n\n`);

  // Keep alive (Render free plan sleeps if no ping)
  const keepAlive = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    try {
      res.end();
    } catch (_) {}
  });
});

// --- MCP invocation endpoint ---
app.post("/invocations", (req, res) => {
  const { name, arguments: args } = req.body || {};
  if (name !== "yesno")
    return res.status(400).json({ error: "Unknown tool", name });

  const prompt = (args?.prompt || "").toString();
  res.json({ answer: yesNoRandom(), prompt });
});

// --- 404 fallback ---
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// --- Start server ---
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`✅ YesNo MCP Server v1.3.0 (crypto-random + SSE + flushHeaders) listening on ${PORT}`);
});
