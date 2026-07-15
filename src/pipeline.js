import path from "node:path";
import fs from "node:fs";
import { config, COST_ESTIMATE_USD, modelForTier, tierCostMult } from "./config.js";
import {
  runModel, outputUrls, predictSeconds,
  buildTextToVideo, buildImageToVideo, buildTTS, buildAvatar, buildUpscale,
} from "./providers/replicate.js";
import { saveJob, downloadOutput, jobOutputDir } from "./jobs.js";
import { muxNarration, concatVideos, burnCaption, probeDuration, extractLastFrame } from "./ffmpeg.js";

// Each mode is an async orchestration over one or more Replicate models plus,
// for explainer, local ffmpeg assembly. Progress is streamed via onProgress.

export async function runJob(job, { signal, onProgress }) {
  const emit = (text, extra = {}) => {
    job.step = text;
    job.progress.push({ t: new Date().toISOString(), text });
    Object.assign(job, extra);
    saveJob(job);
    onProgress?.({ type: "progress", text, status: job.status, ...extra });
  };
  const addCost = (usd) => { job.costEstimateUSD = Math.round((job.costEstimateUSD + usd) * 1000) / 1000; };
  // Live cost: accumulate Replicate's actual compute time and convert to $.
  const addCompute = (pred) => {
    job.computeSeconds = Math.round(((job.computeSeconds || 0) + predictSeconds(pred)) * 100) / 100;
    job.actualCostUSD = Math.round(job.computeSeconds * config.costPerComputeSec * 1000) / 1000;
  };

  job.status = "running";
  job.computeSeconds = 0;
  job.actualCostUSD = 0;
  emit("Starting…");

  const p = job.params;
  const logForModel = (label) => (status) => onProgress?.({ type: "model", label, status });

  try {
    switch (job.mode) {
      case "clip":
      case "short": {
        const isShort = job.mode === "short";
        const aspectRatio = p.aspectRatio || (isShort ? "9:16" : "16:9");
        const tier = p.tier || config.defaultTier;
        const seg = config.clipSegmentSeconds;
        const target = Math.min(Number(p.duration) || seg, config.maxTargetSeconds);
        const nSegments = Math.max(1, Math.ceil(target / seg));

        const localSegments = []; // files to concat (upscaled if requested)
        let prevBasePath = null;  // previous segment's base-res clip, for last-frame continuation

        for (let i = 0; i < nSegments; i++) {
          const label = nSegments > 1 ? `segment ${i + 1}/${nSegments}` : "video";
          let slug, input, usingImage;
          if (i === 0) {
            usingImage = Boolean(p.image);
            slug = modelForTier(tier, usingImage ? "i2v" : "t2v");
            input = usingImage
              ? buildImageToVideo({ ...p, aspectRatio, duration: seg })
              : buildTextToVideo({ ...p, aspectRatio, duration: seg });
          } else {
            // Continue from the previous clip's last frame for visual continuity.
            usingImage = true;
            const framePath = path.join(jobOutputDir(job.id), `frame-${i}.png`);
            await extractLastFrame(prevBasePath, framePath, { signal });
            const frameUri = `data:image/png;base64,${fs.readFileSync(framePath).toString("base64")}`;
            slug = modelForTier(tier, "i2v");
            input = buildImageToVideo({ prompt: p.prompt, image: frameUri, aspectRatio, duration: seg, advancedInput: p.advancedInput });
          }

          emit(`Generating ${label} with ${slug} (${tier})…`);
          const pred = await runModel(slug, input, { signal, onUpdate: logForModel(label) });
          addCompute(pred);
          addCost((usingImage ? COST_ESTIMATE_USD.imageToVideo : COST_ESTIMATE_USD.textToVideo) * tierCostMult(tier));
          const [url] = outputUrls(pred.output);
          if (!url) throw new Error(`${label}: model returned no video output.`);

          emit(`Downloading ${label}…`);
          const base = await downloadOutput(job.id, url, `segment-${i + 1}`);
          prevBasePath = base.absPath;

          let segFile = base.absPath;
          if (p.upscale4k) {
            emit(`Upscaling ${label} to 4K with ${config.models.upscale}…`);
            const upPred = await runModel(config.models.upscale,
              buildUpscale({ video: url, targetInput: config.upscaleInput, advancedInput: p.advancedUpscale }),
              { signal, onUpdate: logForModel(`${label} 4K upscale`) });
            addCompute(upPred);
            addCost(COST_ESTIMATE_USD.upscale);
            const [upUrl] = outputUrls(upPred.output);
            if (!upUrl) throw new Error(`${label}: upscaler returned no output.`);
            const up = await downloadOutput(job.id, upUrl, `segment-${i + 1}-4k`);
            segFile = up.absPath;
          }
          localSegments.push(segFile);
        }

        emit(nSegments > 1 ? "Stitching segments…" : "Finalizing…");
        let finalPath = path.join(jobOutputDir(job.id), isShort ? "short.mp4" : "clip.mp4");
        await concatVideos(localSegments, finalPath, { signal });

        if (isShort && p.caption) {
          emit("Burning caption…");
          const captioned = path.join(jobOutputDir(job.id), "short-captioned.mp4");
          try {
            await burnCaption(finalPath, p.caption, captioned, { signal });
            finalPath = captioned;
          } catch (e) {
            emit(`Caption step skipped (${e.message.slice(0, 80)}).`);
          }
        }
        const dur = await probeDuration(finalPath).catch(() => 0);
        const fn = path.basename(finalPath);
        job.outputs.push({ file: fn, url: `/outputs/${job.id}/${fn}`, kind: "video", durationSec: Math.round(dur) });
        break;
      }

      case "avatar": {
        if (!p.image) throw new Error("Avatar mode needs a portrait image.");
        let audioUrl = p.audioUrl; // if a public URL was supplied
        if (!audioUrl && p.narration) {
          emit(`Generating voiceover with ${config.models.tts}…`);
          const ttsPred = await runModel(config.models.tts,
            buildTTS({ text: p.narration, voice: p.voice || config.ttsVoice, advancedInput: p.advancedTts }),
            { signal, onUpdate: logForModel("voiceover") });
          addCompute(ttsPred);
          addCost(COST_ESTIMATE_USD.tts);
          [audioUrl] = outputUrls(ttsPred.output);
          if (!audioUrl) throw new Error("Voiceover model returned no audio.");
        }
        // Prefer the uploaded audio data URI, else the generated audio URL.
        const audio = p.audio || audioUrl;
        if (!audio) throw new Error("Avatar mode needs narration text or an audio upload.");

        emit(`Generating talking avatar with ${config.models.avatar}…`);
        const pred = await runModel(config.models.avatar,
          buildAvatar({ image: p.image, audio, prompt: p.prompt, advancedInput: p.advancedInput }),
          { signal, onUpdate: logForModel("avatar") });
        addCompute(pred);
        addCost(COST_ESTIMATE_USD.avatar);

        const [url] = outputUrls(pred.output);
        if (!url) throw new Error("Avatar model returned no video output.");
        emit("Downloading result…");
        const out = await downloadOutput(job.id, url, "avatar");
        job.outputs.push({ file: out.file, url: out.url, kind: "video" });
        break;
      }

      case "explainer": {
        const scenes = Array.isArray(p.scenes) ? p.scenes : [];
        if (scenes.length === 0) throw new Error("Explainer mode needs at least one scene.");
        if (scenes.length > config.maxScenes) throw new Error(`Too many scenes (max ${config.maxScenes}).`);
        const aspectRatio = p.aspectRatio || "16:9";
        const sceneClips = [];

        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          const n = i + 1;
          emit(`Scene ${n}/${scenes.length}: voiceover…`);
          const ttsPred = await runModel(config.models.tts,
            buildTTS({ text: scene.narration, voice: p.voice || config.ttsVoice, advancedInput: p.advancedTts }),
            { signal, onUpdate: logForModel(`scene ${n} voiceover`) });
          addCompute(ttsPred);
          addCost(COST_ESTIMATE_USD.tts);
          const [audioUrl] = outputUrls(ttsPred.output);
          if (!audioUrl) throw new Error(`Scene ${n}: voiceover model returned no audio.`);
          const audio = await downloadOutput(job.id, audioUrl, `scene-${n}-narration`);

          emit(`Scene ${n}/${scenes.length}: visuals…`);
          const tier = p.tier || config.defaultTier;
          const vidPred = await runModel(modelForTier(tier, "t2v"),
            buildTextToVideo({ prompt: scene.visualPrompt, aspectRatio, advancedInput: p.advancedVideo }),
            { signal, onUpdate: logForModel(`scene ${n} visuals`) });
          addCompute(vidPred);
          addCost(COST_ESTIMATE_USD.textToVideo * tierCostMult(tier));
          const [vidUrl] = outputUrls(vidPred.output);
          if (!vidUrl) throw new Error(`Scene ${n}: video model returned no output.`);
          const clip = await downloadOutput(job.id, vidUrl, `scene-${n}-clip`);

          emit(`Scene ${n}/${scenes.length}: syncing narration to visuals…`);
          const scenePath = path.join(jobOutputDir(job.id), `scene-${n}.mp4`);
          await muxNarration(clip.absPath, audio.absPath, scenePath, { signal });
          sceneClips.push(scenePath);
        }

        emit("Assembling final video…");
        const finalPath = path.join(jobOutputDir(job.id), "explainer.mp4");
        await concatVideos(sceneClips, finalPath, { signal });
        const dur = await probeDuration(finalPath).catch(() => 0);
        job.outputs.push({
          file: "explainer.mp4",
          url: `/outputs/${job.id}/explainer.mp4`,
          kind: "video",
          durationSec: Math.round(dur),
        });
        break;
      }

      default:
        throw new Error(`Unknown mode: ${job.mode}`);
    }

    job.status = "done";
    emit("Done.");
    onProgress?.({
      type: "done", outputs: job.outputs,
      costEstimateUSD: job.costEstimateUSD,
      actualCostUSD: job.actualCostUSD, computeSeconds: job.computeSeconds,
    });
  } catch (err) {
    job.status = signal?.aborted ? "canceled" : "error";
    job.error = String(err?.message || err);
    saveJob(job);
    onProgress?.({ type: job.status === "canceled" ? "canceled" : "error", text: job.error });
  }
}
