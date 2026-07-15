import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Thin ffmpeg/ffprobe wrappers for assembling explainer videos and burning
// captions onto shorts. ffmpeg is installed in the Docker image.

function run(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${bin} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

export async function hasFfmpeg() {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export async function probeDuration(file) {
  const out = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const d = parseFloat(String(out).trim());
  return Number.isFinite(d) ? d : 0;
}

/**
 * Mux one narration audio track over a video clip, looping/trimming the video
 * to the narration length. Produces a self-contained scene clip.
 */
export async function muxNarration(videoFile, audioFile, outFile, { signal } = {}) {
  await run("ffmpeg", [
    "-y",
    "-stream_loop", "-1", "-i", videoFile,
    "-i", audioFile,
    "-map", "0:v:0", "-map", "1:a:0",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    outFile,
  ], { signal });
  return outFile;
}

/** Grab the last frame of a video as a PNG — used to continue the next segment. */
export async function extractLastFrame(videoFile, outImage, { signal } = {}) {
  await run("ffmpeg", [
    "-y", "-sseof", "-0.2", "-i", videoFile,
    "-frames:v", "1", "-update", "1", "-q:v", "2", outImage,
  ], { signal });
  return outImage;
}

/** Concatenate scene clips into one video (re-encode for safe concatenation). */
export async function concatVideos(files, outFile, { signal } = {}) {
  if (files.length === 1) {
    fs.copyFileSync(files[0], outFile);
    return outFile;
  }
  const listPath = path.join(path.dirname(outFile), "concat.txt");
  fs.writeFileSync(listPath, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  await run("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
    outFile,
  ], { signal });
  fs.rmSync(listPath, { force: true });
  return outFile;
}

const CAPTION_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

/** Burn a short caption onto a video (centered, lower third). Best-effort. */
export async function burnCaption(videoFile, text, outFile, { signal } = {}) {
  const safe = String(text).replace(/[\\:']/g, " ").replace(/\n/g, " ").slice(0, 120);
  // Pass fontfile explicitly when present (Docker image ships DejaVu); otherwise
  // let drawtext fall back to fontconfig. Caption is best-effort — the pipeline
  // catches a failure here and continues without the overlay.
  const fontArg = fs.existsSync(CAPTION_FONT) ? `:fontfile=${CAPTION_FONT}` : "";
  await run("ffmpeg", [
    "-y", "-i", videoFile,
    "-vf", `drawtext=text='${safe}'${fontArg}:fontcolor=white:fontsize=42:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y=h-th-80`,
    "-c:a", "copy",
    outFile,
  ], { signal });
  return outFile;
}
