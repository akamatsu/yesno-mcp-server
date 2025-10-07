// server.js
// YesNo MCP Server — minimal HTTP API for returning "yes" / "no"
// Render free plan friendly: single file, no build step, $PORT support.

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const app = express();

// --- Middleware ---
app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*", // tighten later if needed
  })
);

// Log concise in prod, verbose in dev
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// --- Tiny helper: deterministic yes/no from prompt ---
function yesNoFromPrompt(prompt = "") {
  // Deterministic checksum -> yes/no (stable for same input)
  let sum = 0;
  for (let i = 0; i < prompt.length; i++) sum = (sum + prompt.charCodeAt(i)) % 9973;
  return sum % 2 === 0 ? "yes" : "no";
}

// --- Routes ---
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/", (_req, res) => {
  res.json({
    name: "YesNo MCP Server",
    version: "1.0.0",
    endpoints: {
      "/healthz": "GET — health check",
      "/yes": 'GET — returns {"answer":"yes"}',
      "/no": 'GET — returns {"answer":"no"}',
      "/answer?prompt=...": 'GET — returns {"answer":"yes"|"no"} (deterministic by prompt)',
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
  const prompt = (req.query.prompt || "").toString();
  const answer = yesNoFromPrompt(prompt);
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
  console.log(`YesNo MCP Server listening on port ${PORT}`);
});