# Aibot — your personal AI on your own droplet

A self-hosted personal AI assistant that runs on a cheap DigitalOcean droplet and is powered by **Claude Fable 5** (Anthropic's most capable model) through the Anthropic API. It has a private web chat UI, real tools (shell, files, web search/fetch), and an **Ultracode mode** that fans work out to parallel subagents.

## ⚠️ Read this first: what this does and doesn't do

- **You cannot self-host Fable 5 (or any Claude model).** The model runs on Anthropic's servers. What this droplet hosts is *your own assistant app* — your UI, your tools, your conversation history — which calls the model with **your API key**.
- **This replaces subscription usage limits with pay-as-you-go billing.** An Anthropic API key (from [console.anthropic.com](https://console.anthropic.com)) is billed per token, separately from a claude.ai subscription. There is no "you've hit your limit" — but every message costs real money:

  | Model | Input / MTok | Output / MTok |
  |---|---|---|
  | `claude-fable-5` (default) | $10 | $50 |
  | `claude-opus-4-8` (set `MODEL=` to halve costs) | $5 | $25 |

  A typical chat turn costs cents. A heavy **Ultracode** run with 6 parallel agents doing research and coding can burn several million tokens — **tens of dollars per task**. Set a monthly spend limit in the Anthropic Console before going wild.
- **Fable 5 requires 30-day data retention** on your API organization (it's unavailable under zero-data-retention). If every request fails with a 400, check that in Console settings or switch to `MODEL=claude-opus-4-8`.

## Features

- **Fable 5 with adaptive thinking** — reasoning summaries streamed to the UI, effort dial from `low` to `max`.
- **Refusal fallback (on by default)** — Fable 5's safety classifiers occasionally decline benign requests; the server-side fallback beta automatically retries the same request on Opus 4.8 within the same call. Disable with `FALLBACKS=off`.
- **Real tools**: bash (runs inside the Docker container — that's the sandbox), a file editor confined to a persistent `workspace/` directory, and Anthropic's server-side web search + web fetch.
- **Ultracode mode**: the assistant becomes an orchestrator with a `spawn_agents` tool — it delegates independent subtasks to up to `MAX_SUBAGENTS` parallel agents, each with its own context and full tool access, then synthesizes their reports.
- **Prompt caching** enabled throughout (~90% cheaper repeated context on long conversations).
- **Private by default**: bearer-token auth on everything, secrets never exposed to the AI's shell, conversations stored as JSON on your disk only.

## Deploy to DigitalOcean (~5 minutes)

1. Create a droplet: **Ubuntu 24.04**, Basic plan (the $6–12/mo sizes are plenty — the model runs at Anthropic, not on the droplet).
2. SSH in and run:

   ```bash
   git clone https://github.com/christianhillman15-afk/Aibot.git
   cd Aibot
   bash deploy/setup-droplet.sh
   ```

   The script installs Docker, generates a login token, asks for your Anthropic API key, opens port 8080, and starts the app.
3. Open `http://YOUR_DROPLET_IP:8080` and log in with the printed token.

**Optional (recommended) — HTTPS:** point a domain at the droplet and put [Caddy](https://caddyserver.com) in front (`caddy reverse-proxy --from ai.yourdomain.com --to localhost:8080` gives you automatic TLS). Until then, treat the token like a password and prefer using the UI over trusted networks.

### Run without Docker (any machine with Node 20+)

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and AUTH_TOKEN
node server.js
```

Note: without Docker, the AI's bash tool runs directly on the host as your user. The container is the recommended sandbox.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. From console.anthropic.com |
| `AUTH_TOKEN` | — | Required. Web UI password (`openssl rand -hex 24`) |
| `MODEL` | `claude-fable-5` | Or `claude-opus-4-8` for half the cost |
| `FALLBACKS` | `on` | Server-side refusal fallback to `FALLBACK_MODEL` |
| `DEFAULT_EFFORT` | `high` | Reasoning depth for standard chats |
| `ULTRA_EFFORT` | `xhigh` | Orchestrator depth in Ultracode mode |
| `SUBAGENT_EFFORT` | `medium` | Depth for spawned subagents (biggest cost lever) |
| `MAX_SUBAGENTS` | `6` | Parallel agent cap in Ultracode mode |
| `PORT` | `8080` | HTTP port |

## Using it

- **Standard mode** — normal assistant chat. It can run shell commands, manage files in `workspace/`, and search the web on its own.
- **Ultracode mode** — for big tasks ("research X from five angles and write a report", "build me a small site in the workspace"). The orchestrator plans, spawns parallel agents, and synthesizes. Watch the ⚡ chips to see agents working. Expect it to take minutes and cost accordingly.
- **Effort** — `auto` uses sensible defaults; drop to `low`/`medium` for quick questions to save money, use `max` when correctness matters more than cost.
- Each reply shows token usage and an approximate cost so you always know what you're spending.

## Security notes

- The AI can execute arbitrary shell commands **inside its Docker container**. That's the point of a personal agent — but it means anyone with your `AUTH_TOKEN` commands the box. Use a strong token, consider HTTPS, and don't expose port 8080 more widely than needed.
- `ANTHROPIC_API_KEY` and `AUTH_TOKEN` are stripped from the environment of every command the AI runs.
- The file-editor tool is hard-confined to `workspace/`.

## Operations

```bash
docker compose logs -f          # tail logs
docker compose restart          # restart
git pull && docker compose up -d --build   # update
```

Conversations live in `data/conversations/`, agent files in `workspace/` — both are plain files you can back up.
