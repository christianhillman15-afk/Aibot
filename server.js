import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { config, ensureDirs, VALID_EFFORTS, PRICES, ROOT_DIR } from "./src/config.js";
import { runAgentTurn } from "./src/agent.js";
import {
  createConversation,
  loadConversation,
  saveConversation,
  deleteConversation,
  listConversations,
} from "./src/store.js";

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------
ensureDirs();

if (!config.authToken && !config.allowNoAuth) {
  console.error(
    "FATAL: AUTH_TOKEN is not set. This server executes shell commands on behalf of the AI —\n" +
      "it must not run unauthenticated. Set AUTH_TOKEN in .env (e.g. `openssl rand -hex 24`),\n" +
      "or set ALLOW_NO_AUTH=1 only if the port is firewalled to localhost."
  );
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("WARNING: ANTHROPIC_API_KEY is not set — chat requests will fail until it is.");
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const busy = new Set(); // conversation ids with an in-flight turn
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT_DIR, "public")));

// ---------------------------------------------------------------------------
// Auth — constant-time bearer-token check on all /api routes
// ---------------------------------------------------------------------------
function tokenMatches(provided) {
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(config.authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use("/api", (req, res, next) => {
  if (!config.authToken && config.allowNoAuth) return next();
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (tokenMatches(provided)) return next();
  res.status(401).json({ error: "Unauthorized" });
});

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: config.model, fallbacks: config.fallbacksEnabled });
});

app.get("/api/conversations", (_req, res) => {
  res.json(listConversations());
});

app.get("/api/conversations/:id", (req, res) => {
  try {
    const conv = loadConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "Not found" });
    res.json(conv);
  } catch {
    res.status(400).json({ error: "Invalid id" });
  }
});

app.delete("/api/conversations/:id", (req, res) => {
  try {
    // Refuse to delete while a turn is running — the in-flight turn saves the
    // conversation on completion and would resurrect a file deleted mid-turn.
    if (busy.has(req.params.id)) {
      return res.status(409).json({ error: "Conversation has a turn in progress; try again in a moment." });
    }
    deleteConversation(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "Invalid id" });
  }
});

// ---------------------------------------------------------------------------
// Chat endpoint — Server-Sent Events stream
// ---------------------------------------------------------------------------
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function approxCost(usage) {
  const [inP, outP] = PRICES[config.model] || PRICES["claude-fable-5"];
  // Cache reads are ~0.1x input price; cache writes ~1.25x. Approximate.
  const dollars =
    (usage.input * inP + usage.cacheWrite * inP * 1.25 + usage.cacheRead * inP * 0.1 + usage.output * outP) / 1e6;
  return Math.round(dollars * 10000) / 10000;
}

app.post("/api/chat", async (req, res) => {
  const { conversationId, message, mode: rawMode, effort: rawEffort } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "'message' is required" });
  }
  const mode = rawMode === "ultra" ? "ultra" : "standard";
  const defaultEffort = mode === "ultra" ? config.ultraEffort : config.defaultEffort;
  const effort = VALID_EFFORTS.includes(rawEffort) ? rawEffort : defaultEffort;

  let conv;
  try {
    conv = conversationId ? loadConversation(conversationId) : null;
  } catch {
    return res.status(400).json({ error: "Invalid conversation id" });
  }
  if (conversationId && !conv) return res.status(404).json({ error: "Conversation not found" });
  if (!conv) {
    conv = createConversation({ mode, title: message.trim().slice(0, 60) });
  }
  if (busy.has(conv.id)) {
    return res.status(409).json({ error: "A turn is already running in this conversation" });
  }
  busy.add(conv.id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let aborted = false;
  const abortController = new AbortController();
  res.on("close", () => {
    aborted = true;
    abortController.abort();
  });
  const heartbeat = setInterval(() => {
    if (!aborted) res.write(": keepalive\n\n");
  }, 15000);

  sse(res, "meta", { conversationId: conv.id, mode, effort, model: config.model });

  conv.messages.push({ role: "user", content: [{ type: "text", text: message }] });

  try {
    const { usage } = await runAgentTurn(client, {
      messages: conv.messages,
      mode,
      effort,
      emit: (e) => {
        if (!aborted) sse(res, e.type, e);
      },
      isAborted: () => aborted,
      signal: abortController.signal,
    });
    saveConversation(conv);
    if (!aborted) {
      sse(res, "done", { usage, approxCostUSD: approxCost(usage) });
    }
  } catch (err) {
    // Persist what we have so the conversation isn't lost on errors.
    try { saveConversation(conv); } catch { /* best effort */ }
    let text = String(err?.message || err);
    if (err instanceof Anthropic.AuthenticationError) {
      text = "Anthropic API key is invalid or missing. Set ANTHROPIC_API_KEY in .env and restart.";
    } else if (err instanceof Anthropic.RateLimitError) {
      text = "Anthropic API rate limit hit. Wait a bit and retry.";
    } else if (err instanceof Anthropic.BadRequestError && config.model === "claude-fable-5") {
      text +=
        "\nNote: claude-fable-5 requires the API organization to have 30-day data retention " +
        "(it is unavailable under zero-data-retention). If every request fails with a 400, check that setting, " +
        "or set MODEL=claude-opus-4-8 in .env.";
    }
    console.error("chat error:", err);
    if (!aborted) sse(res, "error", { text });
  } finally {
    clearInterval(heartbeat);
    busy.delete(conv.id);
    if (!aborted) res.end();
  }
});

app.listen(config.port, () => {
  console.log(`aibot listening on http://0.0.0.0:${config.port}`);
  console.log(`model=${config.model} fallbacks=${config.fallbacksEnabled ? config.fallbackModel : "off"}`);
  if (!config.authToken) console.warn("AUTH DISABLED (ALLOW_NO_AUTH=1) — make sure the port is not public!");
});
