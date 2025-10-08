// server.js
// YesNo MCP Server — crypto-random yes/no + MCP (Streamable HTTP via SSE)
// Works on Render Free. Sends `endpoint` SSE event and handles JSON-RPC at /mcp.
"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { randomInt } = require("crypto");

const app = express();

// --- Middleware ---
app.use(helmet());
app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// --- Utility: crypto-random yes/no ---
function yesNoRandom() {
  return randomInt(0, 2) === 0 ? "yes" : "no";
}

// --- Health & simple HTTP (そのまま残します) ---
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/", (_req, res) => {
  res.json({
    name: "YesNo MCP Server",
    version: "2.0.0",
    mode: "crypto-random",
    transport: "streamable-http (SSE + JSON-RPC)",
    endpoints: {
      "/healthz": "GET — health check",
      "/yes": 'GET — returns {"answer":"yes"}',
      "/no": 'GET — returns {"answer":"no"}',
      "/answer?prompt=...":
        'GET — returns {"answer":"yes"|"no"} (cryptographically random; prompt ignored)',
      "/sse": "GET — MCP connection stream (SSE). Emits `endpoint`.",
      "/mcp": "POST — MCP JSON-RPC endpoint (tools.list / tools.call)",
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

// --- MCP: SSE connection (must immediately announce POST endpoint) ---
app.get("/sse", (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Flush immediately so client receives headers & first event without buffering
  if (res.flushHeaders) res.flushHeaders();

  /**
   * Per Streamable HTTP + SSE, the server should emit an `endpoint` event with
   * the relative URI the client should POST JSON-RPC messages to.
   * (See MCP transport docs; client expects this to proceed.) 
   */
  const endpointEvent = {
    uri: "/mcp",               // relative path to JSON-RPC POST
    protocol: "jsonrpc-2.0",   // indicates JSON-RPC 2.0
    version: "2025-03-26"      // protocol rev (informational)
  };

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify(endpointEvent)}\n\n`);

  // keep-alive pings so the connection stays open
  const keepAlive = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    try { res.end(); } catch (_) {}
  });
});

// --- Minimal JSON-RPC helper ---
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * --- MCP: JSON-RPC endpoint ---
 * Accepts single or batch JSON-RPC requests.
 * Implements:
 *  - "tools/list" → returns yesno tool schema
 *  - "tools/call" → executes yesno and returns MCP-style text content
 */
app.post("/mcp", (req, res) => {
  const body = req.body;
  const now = Date.now();

  // Allow both single-object and array batch
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

    if (method === "tools/list") {
      // Minimal MCP tool schema (name + JSON schema for args)
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

        /**
         * Return content as MCP text blocks.
         * Many clients expect { content: [{ type: "text", text: "..." }] }.
         */
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

    // Not implemented
    responses.push(rpcError(id, -32601, "Method not found"));
  }

  // If original request was a single object, return single object
  res.json(Array.isArray(body) ? responses : responses[0]);
});

// --- 404 fallback ---
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// --- Start server ---
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`✅ YesNo MCP Server v2.0.0 (SSE endpoint + JSON-RPC) on ${PORT}`);
});