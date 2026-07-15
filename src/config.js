import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");

function bool(v, fallback = false) {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export const config = {
  port: Number(process.env.PORT || 8080),
  authToken: process.env.AUTH_TOKEN || "",
  allowNoAuth: bool(process.env.ALLOW_NO_AUTH, false),

  model: process.env.MODEL || "claude-fable-5",
  fallbackModel: process.env.FALLBACK_MODEL || "claude-opus-4-8",
  // Server-side refusal fallbacks are an Anthropic beta; only meaningful on Fable 5.
  fallbacksEnabled: bool(process.env.FALLBACKS, true),

  defaultEffort: process.env.DEFAULT_EFFORT || "high",
  ultraEffort: process.env.ULTRA_EFFORT || "xhigh",
  subagentEffort: process.env.SUBAGENT_EFFORT || "medium",

  maxTokens: Number(process.env.MAX_TOKENS || 64000),
  subagentMaxTokens: Number(process.env.SUBAGENT_MAX_TOKENS || 32000),
  maxToolLoops: Number(process.env.MAX_TOOL_LOOPS || 60),
  maxSubagents: Number(process.env.MAX_SUBAGENTS || 6),
  bashTimeoutMs: Number(process.env.BASH_TIMEOUT_MS || 180000),
  maxToolResultChars: Number(process.env.MAX_TOOL_RESULT_CHARS || 30000),

  dataDir: path.resolve(ROOT_DIR, process.env.DATA_DIR || "data"),
  workspaceDir: path.resolve(ROOT_DIR, process.env.WORKSPACE_DIR || "workspace"),
};

export const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function ensureDirs() {
  fs.mkdirSync(path.join(config.dataDir, "conversations"), { recursive: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
}

// Rough $/MTok input,output — used only for the approximate cost readout in the UI.
export const PRICES = {
  "claude-fable-5": [10, 50],
  "claude-opus-4-8": [5, 25],
};
