import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "./config.js";

const jobsDir = () => path.join(config.dataDir, "jobs");

function fileFor(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid job id");
  return path.join(jobsDir(), `${id}.json`);
}

export function createJob({ mode, params }) {
  const id = crypto.randomBytes(8).toString("hex");
  const job = {
    id,
    mode,
    params: redactParams(params), // never persist raw base64 uploads
    status: "queued", // queued | running | done | error | canceled
    step: "",
    progress: [], // [{ t, text }]
    outputs: [], // [{ file, url }] relative to /outputs
    error: null,
    costEstimateUSD: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveJob(job);
  return job;
}

// Uploaded images/audio arrive as big data: URIs. Keep them out of the saved
// JSON (and out of listings) — store only a short marker.
function redactParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (typeof v === "string" && v.startsWith("data:")) out[k] = `<${v.slice(5, v.indexOf(";")) || "upload"}>`;
    else if (k === "scenes" && Array.isArray(v)) out[k] = v.map((s) => ({ narration: s.narration, visualPrompt: s.visualPrompt }));
    else out[k] = v;
  }
  return out;
}

export function loadJob(id) {
  const f = fileFor(id);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  const f = fileFor(job.id);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job), "utf8");
  fs.renameSync(tmp, f);
}

export function listJobs() {
  if (!fs.existsSync(jobsDir())) return [];
  return fs
    .readdirSync(jobsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(jobsDir(), f), "utf8"));
        return {
          id: j.id, mode: j.mode, status: j.status, step: j.step,
          outputs: j.outputs, error: j.error, costEstimateUSD: j.costEstimateUSD,
          createdAt: j.createdAt, updatedAt: j.updatedAt,
          title: jobTitle(j),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function jobTitle(j) {
  const p = j.params || {};
  return (p.prompt || p.title || (p.scenes && p.scenes[0]?.visualPrompt) || j.mode || "job").slice(0, 70);
}

export function deleteJob(id) {
  const f = fileFor(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  const dir = jobOutputDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function jobOutputDir(id) {
  return path.join(config.outputDir, id);
}

/** Download a remote URL into the job's output dir; return { file, url, absPath }. */
export async function downloadOutput(jobId, url, name) {
  const dir = jobOutputDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download output (${res.status}) from ${url}`);
  const ext = extForContentType(res.headers.get("content-type")) || path.extname(new URL(url).pathname) || ".bin";
  const filename = name.endsWith(ext) ? name : `${name}${ext}`;
  const absPath = path.join(dir, filename);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(absPath));
  return { file: filename, url: `/outputs/${jobId}/${filename}`, absPath };
}

function extForContentType(ct) {
  if (!ct) return null;
  if (ct.includes("mp4")) return ".mp4";
  if (ct.includes("webm")) return ".webm";
  if (ct.includes("quicktime")) return ".mov";
  if (ct.includes("mpeg")) return ".mp3";
  if (ct.includes("wav")) return ".wav";
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg")) return ".jpg";
  return null;
}
