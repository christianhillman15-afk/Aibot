import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";

import { config, ensureDirs, MODES, COST_ESTIMATE_USD, tierCostMult, ROOT_DIR } from "./src/config.js";
import { createJob, loadJob, saveJob, listJobs, deleteJob } from "./src/jobs.js";
import { runJob } from "./src/pipeline.js";
import { hasFfmpeg } from "./src/ffmpeg.js";
import { presetPayload } from "./src/presets.js";

ensureDirs();

if (!config.authToken && !config.allowNoAuth) {
  console.error(
    "FATAL: AUTH_TOKEN is not set. This server spends money generating videos on your\n" +
      "Replicate account — it must not run unauthenticated. Set AUTH_TOKEN in .env\n" +
      "(e.g. `openssl rand -hex 24`), or set ALLOW_NO_AUTH=1 only if the port is firewalled."
  );
  process.exit(1);
}
if (!config.replicateToken) {
  console.warn("WARNING: REPLICATE_API_TOKEN is not set — generation will fail until it is.");
}

const app = express();
app.use(express.json({ limit: `${config.bodyLimitMb}mb` }));
app.use(express.static(path.join(ROOT_DIR, "public")));
// Generated media. Served without the /api auth gate so <video> tags load
// directly; access relies on the unguessable 16-hex job id in the path. Put the
// app behind HTTPS + a reverse proxy if you need true access control on outputs.
app.use("/outputs", express.static(config.outputDir));

// ---- auth ----
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

// ---- job runner: small queue + per-job event bus + cancellation ----
const active = new Map(); // jobId -> AbortController
const buses = new Map(); // jobId -> EventEmitter
const queue = []; // jobIds waiting for a slot

function busFor(id) {
  let b = buses.get(id);
  if (!b) { b = new EventEmitter(); b.setMaxListeners(0); buses.set(id, b); }
  return b;
}

function pump() {
  while (active.size < config.maxConcurrentJobs && queue.length > 0) {
    const id = queue.shift();
    const job = loadJob(id);
    if (!job || job.status !== "queued") continue;
    start(job);
  }
}

function start(job) {
  const ac = new AbortController();
  active.set(job.id, ac);
  const bus = busFor(job.id);
  runJob(job, {
    signal: ac.signal,
    onProgress: (evt) => bus.emit("evt", evt),
  }).finally(() => {
    active.delete(job.id);
    bus.emit("evt", { type: "end", status: loadJob(job.id)?.status });
    pump();
  });
}

// ---- upfront cost estimate (ballpark) ----
function estimateCost(mode, params) {
  const c = COST_ESTIMATE_USD;
  const mult = tierCostMult(params.tier || config.defaultTier);
  if (mode === "clip" || mode === "short") {
    const target = Math.min(Number(params.duration) || config.clipSegmentSeconds, config.maxTargetSeconds);
    const segments = Math.max(1, Math.ceil(target / config.clipSegmentSeconds));
    const perSeg = (params.image ? c.imageToVideo : c.textToVideo) * mult + (params.upscale4k ? c.upscale : 0);
    return segments * perSeg;
  }
  if (mode === "avatar") return c.avatar + (params.narration ? c.tts : 0);
  if (mode === "explainer") return (params.scenes?.length || 0) * (c.textToVideo * mult + c.tts);
  return 0;
}

function validate(mode, params) {
  if (!MODES.includes(mode)) return "Unknown mode.";
  if (mode === "clip" || mode === "short") {
    if (!params.prompt && !params.image) return "Provide a prompt or a reference image.";
  } else if (mode === "avatar") {
    if (!params.image) return "Upload a portrait image.";
    if (!params.narration && !params.audio && !params.audioUrl) return "Provide narration text or an audio upload.";
  } else if (mode === "explainer") {
    if (!Array.isArray(params.scenes) || params.scenes.length === 0) return "Add at least one scene.";
    for (const [i, s] of params.scenes.entries()) {
      if (!s || !s.narration || !s.visualPrompt) return `Scene ${i + 1} needs both narration and a visual prompt.`;
    }
  }
  return null;
}

// ---- REST ----
app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    models: config.models,
    tiers: Object.fromEntries(Object.entries(config.tiers).map(([k, v]) => [k, { label: v.label, costMult: v.costMult }])),
    defaultTier: config.defaultTier,
    ffmpeg: await hasFfmpeg(),
    replicateConfigured: Boolean(config.replicateToken),
  });
});

app.get("/api/presets", (_req, res) => res.json(presetPayload()));

app.get("/api/jobs", (_req, res) => res.json(listJobs()));

app.get("/api/jobs/:id", (req, res) => {
  try {
    const job = loadJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Not found" });
    res.json(job);
  } catch { res.status(400).json({ error: "Invalid id" }); }
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const ac = active.get(req.params.id);
  if (ac) { ac.abort(); return res.json({ ok: true, canceled: true }); }
  res.status(409).json({ error: "Job is not running" });
});

app.delete("/api/jobs/:id", (req, res) => {
  try {
    if (active.has(req.params.id)) return res.status(409).json({ error: "Job is running — cancel it first." });
    deleteJob(req.params.id);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: "Invalid id" }); }
});

app.post("/api/generate", (req, res) => {
  const { mode, params } = req.body || {};
  const err = validate(mode, params || {});
  if (err) return res.status(400).json({ error: err });

  const job = createJob({ mode, params });
  job.costEstimateUSD = 0;
  saveJob(job);
  const upfront = estimateCost(mode, params);

  queue.push(job.id);
  pump();
  res.json({ jobId: job.id, estimateUSD: Math.round(upfront * 1000) / 1000 });
});

// ---- SSE progress stream ----
app.get("/api/jobs/:id/stream", (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  // Replay current state so a late subscriber isn't stuck waiting.
  send({ type: "state", status: job.status, step: job.step, progress: job.progress, outputs: job.outputs, error: job.error, costEstimateUSD: job.costEstimateUSD, actualCostUSD: job.actualCostUSD, computeSeconds: job.computeSeconds });

  if (job.status === "done" || job.status === "error" || job.status === "canceled") {
    send({ type: "end", status: job.status });
    return res.end();
  }

  const bus = busFor(job.id);
  const onEvt = (evt) => {
    send(evt);
    if (evt.type === "end") { cleanup(); res.end(); }
  };
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
  function cleanup() { clearInterval(heartbeat); bus.off("evt", onEvt); }
  bus.on("evt", onEvt);
  req.on("close", cleanup);
});

app.listen(config.port, () => {
  console.log(`video-studio listening on http://0.0.0.0:${config.port}`);
  console.log(`models: ${JSON.stringify(config.models)}`);
  if (!config.authToken) console.warn("AUTH DISABLED (ALLOW_NO_AUTH=1) — do not expose this port publicly!");
});
