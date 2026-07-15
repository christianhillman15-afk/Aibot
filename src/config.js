import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");

function bool(v, fallback = false) {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}
const str = (v, d) => (v === undefined || v === "" ? d : String(v));
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8080),
  authToken: process.env.AUTH_TOKEN || "",
  allowNoAuth: bool(process.env.ALLOW_NO_AUTH, false),

  // Video/audio generation runs on Replicate (one key, many models).
  replicateToken: process.env.REPLICATE_API_TOKEN || "",
  replicateBase: str(process.env.REPLICATE_BASE_URL, "https://api.replicate.com/v1"),

  // Model slugs per role. These are the "best cheap" defaults (cost-sensitive);
  // swap any of them for a premium model in .env — see README for the menu.
  // Verified as live Replicate slugs (July 2026); if one is retired, the app
  // surfaces Replicate's error verbatim so you can update the slug here.
  models: {
    textToVideo: str(process.env.MODEL_T2V, "wan-video/wan-2.5-t2v"),
    imageToVideo: str(process.env.MODEL_I2V, "wan-video/wan-2.5-i2v"),
    tts: str(process.env.MODEL_TTS, "jaaari/kokoro-82m"),
    avatar: str(process.env.MODEL_AVATAR, "bytedance/omni-human"),
    lipsync: str(process.env.MODEL_LIPSYNC, "sync/lipsync-2"),
  },

  // Quality tiers = the cost lever. Draft is the cost-efficient default: fast,
  // cheap model variants. Premium swaps in flagship models (better motion +
  // native audio) at several times the price. Each is configurable in .env.
  tiers: {
    draft: {
      label: "Draft — cheapest & fast",
      textToVideo: str(process.env.MODEL_T2V_DRAFT, "wan-video/wan-2.5-t2v-fast"),
      imageToVideo: str(process.env.MODEL_I2V_DRAFT, "wan-video/wan-2.5-i2v-fast"),
      costMult: num(process.env.TIER_DRAFT_MULT, 0.5),
    },
    standard: {
      label: "Standard — balanced",
      textToVideo: str(process.env.MODEL_T2V, "wan-video/wan-2.5-t2v"),
      imageToVideo: str(process.env.MODEL_I2V, "wan-video/wan-2.5-i2v"),
      costMult: 1,
    },
    premium: {
      label: "Premium — flagship quality",
      textToVideo: str(process.env.MODEL_T2V_PREMIUM, "kwaivgi/kling-v3-video"),
      imageToVideo: str(process.env.MODEL_I2V_PREMIUM, "kwaivgi/kling-v3-video"),
      costMult: num(process.env.TIER_PREMIUM_MULT, 4),
    },
  },
  defaultTier: str(process.env.DEFAULT_TIER, "draft"),

  ttsVoice: str(process.env.TTS_VOICE, "af_heart"),

  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 3000),
  pollTimeoutMs: num(process.env.POLL_TIMEOUT_MS, 15 * 60 * 1000),
  maxConcurrentJobs: num(process.env.MAX_CONCURRENT_JOBS, 2),
  maxScenes: num(process.env.MAX_SCENES, 8),
  bodyLimitMb: num(process.env.BODY_LIMIT_MB, 60),

  dataDir: path.resolve(ROOT_DIR, str(process.env.DATA_DIR, "data")),
  outputDir: path.resolve(ROOT_DIR, str(process.env.OUTPUT_DIR, "outputs")),
};

// Rough per-generation cost ESTIMATES in USD, purely for the UI readout.
// Replicate bills by compute-seconds per model, which varies with duration and
// hardware — treat these as ballpark, not invoices. Edit to match your models.
export const COST_ESTIMATE_USD = {
  textToVideo: num(process.env.COST_T2V, 0.25),
  imageToVideo: num(process.env.COST_I2V, 0.25),
  tts: num(process.env.COST_TTS, 0.02),
  avatar: num(process.env.COST_AVATAR, 0.5),
  lipsync: num(process.env.COST_LIPSYNC, 0.4),
};

export const MODES = ["clip", "short", "explainer", "avatar"];

export function tierFor(name) {
  return config.tiers[name] || config.tiers[config.defaultTier] || config.tiers.standard;
}
export function modelForTier(name, kind) {
  const t = tierFor(name);
  return kind === "i2v" ? t.imageToVideo : t.textToVideo;
}
export function tierCostMult(name) {
  return tierFor(name).costMult ?? 1;
}

export function ensureDirs() {
  fs.mkdirSync(path.join(config.dataDir, "jobs"), { recursive: true });
  fs.mkdirSync(config.outputDir, { recursive: true });
}
