import path from "node:path";
import { config, COST_ESTIMATE_USD, modelForTier, tierCostMult } from "./config.js";
import {
  runModel, outputUrls,
  buildTextToVideo, buildImageToVideo, buildTTS, buildAvatar,
} from "./providers/replicate.js";
import { saveJob, downloadOutput, jobOutputDir } from "./jobs.js";
import { muxNarration, concatVideos, burnCaption, probeDuration } from "./ffmpeg.js";

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

  job.status = "running";
  emit("Starting…");

  const p = job.params;
  const logForModel = (label) => (status) => onProgress?.({ type: "model", label, status });

  try {
    switch (job.mode) {
      case "clip":
      case "short": {
        const isShort = job.mode === "short";
        const aspectRatio = p.aspectRatio || (isShort ? "9:16" : "16:9");
        const usingImage = Boolean(p.image);
        const tier = p.tier || config.defaultTier;
        const slug = modelForTier(tier, usingImage ? "i2v" : "t2v");
        emit(`Generating video with ${slug} (${tier})…`);
        const input = usingImage
          ? buildImageToVideo({ ...p, aspectRatio })
          : buildTextToVideo({ ...p, aspectRatio });
        const pred = await runModel(slug, input, { signal, onUpdate: logForModel("video") });
        addCost((usingImage ? COST_ESTIMATE_USD.imageToVideo : COST_ESTIMATE_USD.textToVideo) * tierCostMult(tier));

        const [url] = outputUrls(pred.output);
        if (!url) throw new Error("Model returned no video output.");
        emit("Downloading result…");
        let out = await downloadOutput(job.id, url, "video");

        if (isShort && p.caption) {
          emit("Burning caption…");
          const captioned = path.join(jobOutputDir(job.id), "short-captioned.mp4");
          try {
            await burnCaption(out.absPath, p.caption, captioned, { signal });
            out = { file: path.basename(captioned), url: `/outputs/${job.id}/${path.basename(captioned)}`, absPath: captioned };
          } catch (e) {
            emit(`Caption step skipped (${e.message.slice(0, 80)}).`);
          }
        }
        job.outputs.push({ file: out.file, url: out.url, kind: "video" });
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
          addCost(COST_ESTIMATE_USD.tts);
          const [audioUrl] = outputUrls(ttsPred.output);
          if (!audioUrl) throw new Error(`Scene ${n}: voiceover model returned no audio.`);
          const audio = await downloadOutput(job.id, audioUrl, `scene-${n}-narration`);

          emit(`Scene ${n}/${scenes.length}: visuals…`);
          const tier = p.tier || config.defaultTier;
          const vidPred = await runModel(modelForTier(tier, "t2v"),
            buildTextToVideo({ prompt: scene.visualPrompt, aspectRatio, advancedInput: p.advancedVideo }),
            { signal, onUpdate: logForModel(`scene ${n} visuals`) });
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
    onProgress?.({ type: "done", outputs: job.outputs, costEstimateUSD: job.costEstimateUSD });
  } catch (err) {
    job.status = signal?.aborted ? "canceled" : "error";
    job.error = String(err?.message || err);
    saveJob(job);
    onProgress?.({ type: job.status === "canceled" ? "canceled" : "error", text: job.error });
  }
}
