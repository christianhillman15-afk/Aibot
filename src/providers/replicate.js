import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Replicate REST client.
//
// Run an official model by name:  POST /v1/models/{owner}/{name}/predictions
// Poll a prediction:              GET  {prediction.urls.get}
// Terminal statuses:              succeeded | failed | canceled
//
// File inputs (images, audio) may be passed as data: URIs — no public hosting
// needed. The app converts uploads to data URIs before calling here.
// ---------------------------------------------------------------------------

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

function authHeaders() {
  if (!config.replicateToken) {
    throw new Error("REPLICATE_API_TOKEN is not set — add it to .env (get one at replicate.com/account/api-tokens).");
  }
  return {
    Authorization: `Bearer ${config.replicateToken}`,
    "Content-Type": "application/json",
  };
}

async function api(url, { method = "GET", body, signal } = {}) {
  const full = url.startsWith("http") ? url : `${config.replicateBase}${url}`;
  const res = await fetch(full, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json?.detail || json?.title || json?.raw || res.statusText;
    const err = new Error(`Replicate ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Create a prediction for an official model (owner/name) and poll to completion.
 * @param slug   "owner/name"
 * @param input  model input object
 * @param opts   { signal, onUpdate(status, prediction) }
 * @returns the terminal prediction object
 */
export async function runModel(slug, input, { signal, onUpdate } = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`Invalid model slug "${slug}" — expected "owner/name".`);
  }
  let prediction = await api(`/models/${slug}/predictions`, {
    method: "POST",
    body: { input },
    signal,
  });
  onUpdate?.(prediction.status, prediction);

  const deadline = Date.now() + config.pollTimeoutMs;
  while (!TERMINAL.has(prediction.status)) {
    if (signal?.aborted) {
      // Best-effort cancel so we stop paying for compute.
      try {
        if (prediction.urls?.cancel) await api(prediction.urls.cancel, { method: "POST" });
      } catch { /* ignore */ }
      throw new Error("Generation canceled.");
    }
    if (Date.now() > deadline) {
      throw new Error(`Generation timed out after ${Math.round(config.pollTimeoutMs / 1000)}s (still ${prediction.status}).`);
    }
    await sleep(config.pollIntervalMs, signal);
    prediction = await api(prediction.urls.get, { signal });
    onUpdate?.(prediction.status, prediction);
  }

  if (prediction.status !== "succeeded") {
    const why = prediction.error || `status ${prediction.status}`;
    throw new Error(`Model ${slug} did not succeed: ${why}`);
  }
  return prediction;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(t);
      reject(new Error("Generation canceled."));
    }, { once: true });
  });
}

/**
 * Normalize a prediction's `output` (string | string[] | object) into a flat
 * list of result URLs. Video/audio models return a URL or an array of URLs;
 * some wrap it in { video: url } / { audio: url } / { output: url }.
 */
export function outputUrls(output) {
  const urls = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === "string") {
      if (/^https?:\/\//.test(v)) urls.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === "object") {
      for (const key of ["video", "audio", "output", "url", "image"]) {
        if (v[key]) walk(v[key]);
      }
      // Fall back to any string-valued props that look like URLs.
      if (urls.length === 0) Object.values(v).forEach(walk);
    }
  };
  walk(output);
  return urls;
}

// ---------------------------------------------------------------------------
// Input builders — map the app's normalized fields to each model's input keys.
//
// ⚠️ Input keys vary by model and change over time. These defaults follow the
// most common Replicate conventions (prompt / aspect_ratio / duration /
// resolution / image / audio). If a model rejects an input, the exact error is
// shown in the UI — adjust the mapping here, or pass overrides via the request's
// `advancedInput` (which is merged last and wins).
// ---------------------------------------------------------------------------

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

export function buildTextToVideo(p = {}) {
  return defined({
    prompt: p.prompt,
    negative_prompt: p.negativePrompt,
    aspect_ratio: p.aspectRatio,
    duration: p.duration,
    resolution: p.resolution,
    seed: p.seed,
    ...(p.advancedInput || {}),
  });
}

export function buildImageToVideo(p = {}) {
  return defined({
    image: p.image,
    prompt: p.prompt,
    negative_prompt: p.negativePrompt,
    aspect_ratio: p.aspectRatio,
    duration: p.duration,
    resolution: p.resolution,
    seed: p.seed,
    ...(p.advancedInput || {}),
  });
}

export function buildTTS(p = {}) {
  return defined({
    text: p.text,
    voice: p.voice,
    speed: p.speed,
    ...(p.advancedInput || {}),
  });
}

export function buildAvatar(p = {}) {
  // bytedance/omni-human style: portrait image + driving audio -> talking video.
  return defined({
    image: p.image,
    audio: p.audio,
    prompt: p.prompt,
    ...(p.advancedInput || {}),
  });
}

export function buildLipsync(p = {}) {
  // sync/lipsync-2 style: a base video (or image) + audio -> lip-synced video.
  return defined({
    video: p.video,
    image: p.image,
    audio: p.audio,
    ...(p.advancedInput || {}),
  });
}
