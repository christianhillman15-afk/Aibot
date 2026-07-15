# Video Studio — self-hosted professional video generator

A deployable web app that generates **professional videos** from a browser, running on your own DigitalOcean droplet. Four modes:

- **Cinematic clip** — text (or a reference image) → a polished video clip.
- **Social short** — vertical 9:16 video with an optional burned-in caption, for TikTok / Reels / Shorts.
- **Explainer / ad** — a multi-scene script becomes a narrated video: each scene gets its own AI voiceover + AI clip, stitched together with ffmpeg.
- **Talking avatar / UGC** — a portrait photo + a voiceover script (or your own audio) → a talking-head video.

## ⚠️ How this works (and what it costs)

No AI model that generates video runs on your droplet — video models are huge and run on GPUs. This app is the *studio*: the web UI, the job orchestration, voiceover + clip assembly. It calls **[Replicate](https://replicate.com)** (one API key, a whole catalog of video/audio models) to do the actual generation, billed **pay-as-you-go to your Replicate account**.

**Every generation costs real money.** Rough ballpark with the default (cheaper) models:

| Output | Rough cost |
|---|---|
| One cinematic clip or short | ~$0.15–0.40 |
| One talking-avatar video | ~$0.40–0.70 |
| A 4-scene explainer (4 voiceovers + 4 clips) | ~$1–2 |

Premium models (Veo 3.1, Kling v3, Seedance 2.0) look noticeably better and add native audio, but cost several times more per clip. The UI shows a **rough estimate** before you generate and a per-job estimate after — set a spend limit in your Replicate account so nothing runs away.

## Deploy to DigitalOcean (~5 minutes)

1. Create a droplet: **Ubuntu 24.04**, Basic plan. The $8–12/mo sizes are plenty — generation happens on Replicate's GPUs, not the droplet (the droplet only needs enough muscle for ffmpeg assembly).
2. SSH in and run:

   ```bash
   git clone https://github.com/christianhillman15-afk/Aibot.git
   cd Aibot
   bash deploy/setup-droplet.sh
   ```

   The script installs Docker + ffmpeg (in the image), generates a login token, asks for your Replicate token, opens port 8080, and starts everything.
3. Open `http://YOUR_DROPLET_IP:8080` and log in with the printed token.

**Recommended — HTTPS:** point a domain at the droplet and front it with [Caddy](https://caddyserver.com) (`caddy reverse-proxy --from studio.yourdomain.com --to localhost:8080`) for automatic TLS. Until then, treat the access token like a password.

### Run locally (Node 20+, needs ffmpeg on PATH)

```bash
npm install
cp .env.example .env   # set REPLICATE_API_TOKEN and AUTH_TOKEN
node server.js
```

## Choosing models

Model slugs are set in `.env` and can be swapped without touching code:

| Role | Default (cheaper) | Premium swaps |
|---|---|---|
| Text→video | `wan-video/wan-2.5-t2v` | `google/veo-3.1`, `kwaivgi/kling-v3-video`, `bytedance/seedance-2.0` |
| Image→video | `wan-video/wan-2.5-i2v` | `google/veo-3.1`, `kwaivgi/kling-v3-video` |
| Voiceover (TTS) | `jaaari/kokoro-82m` | `minimax/speech-2.8-hd` (voice cloning) |
| Talking avatar | `bytedance/omni-human` | `sync/lipsync-2` |

**Model input keys vary and change over time.** This app maps its form fields to the most common Replicate input names (`prompt`, `aspect_ratio`, `duration`, `resolution`, `image`, `audio`). If a model you swap in rejects an input, **Replicate's exact error is shown in the UI** — fix it either by editing the mapping in `src/providers/replicate.js`, or by pasting an override into the **Advanced (raw model input)** box in the form (it's merged last and wins). Nothing fails silently.

## Using it

1. Pick a mode tab. Fill in the prompt / upload an image / write scenes.
2. **Generate** — the job runs in the background; you watch live progress (queued → generating → downloading → assembling → done) and the finished video plays inline.
3. Everything lands in the **Library** on the right — play, download, or delete. Long jobs can be canceled mid-run (stops paying for compute).

## Security notes

- Bearer-token auth gates the whole API and the UI. Use a strong `AUTH_TOKEN`; consider HTTPS.
- Your `REPLICATE_API_TOKEN` stays server-side and is never sent to the browser.
- Generated videos are served from `/outputs/<job-id>/…` (unguessable job IDs). Uploaded images/audio are sent to Replicate as data URIs and are **not** persisted in job records (only a small marker is stored).

## Operations

```bash
docker compose logs -f          # tail logs
docker compose restart          # restart
git pull && docker compose up -d --build   # update
```

Job records live in `data/jobs/`, finished videos in `outputs/` — both are plain files you can back up or clear out.

## How it's built

- `server.js` — Express API: auth, a small job queue with cancellation, SSE progress streaming, static UI + `/outputs`.
- `src/providers/replicate.js` — Replicate REST client (create prediction → poll → extract output URLs) and the editable model-input mapping.
- `src/pipeline.js` — per-mode orchestration (clip / short / avatar / explainer), including the explainer's per-scene voiceover + clip + ffmpeg stitch.
- `src/ffmpeg.js` — assembly helpers (mux narration, concat scenes, burn captions).
- `src/jobs.js` — on-disk job store + output downloader.
