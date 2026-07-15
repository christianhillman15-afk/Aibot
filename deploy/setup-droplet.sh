#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04/24.04 DigitalOcean droplet.
# Run as root FROM THE REPO ROOT:  bash deploy/setup-droplet.sh
set -euo pipefail

if [ ! -f docker-compose.yml ]; then
  echo "Run this from the repository root (where docker-compose.yml lives)." >&2
  exit 1
fi

echo "==> Installing Docker (if missing)..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Configuring .env..."
if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN=$(openssl rand -hex 24)
  # Use a non-/ delimiter so tokens containing slashes don't break sed.
  sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=${TOKEN}|" .env
  if [ -t 0 ]; then
    read -rp "Paste your Replicate API token (r8_...): " KEY
    sed -i "s|^REPLICATE_API_TOKEN=.*|REPLICATE_API_TOKEN=${KEY}|" .env
  else
    echo "No TTY — edit .env and set REPLICATE_API_TOKEN manually, then: docker compose up -d --build"
  fi
  chmod 600 .env
  echo "Generated web UI access token: ${TOKEN}"
else
  echo ".env already exists — leaving it untouched."
fi

echo "==> Firewall (ufw)..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null || true
  ufw allow 8080/tcp >/dev/null || true
  ufw --force enable >/dev/null || true
fi

echo "==> Building and starting..."
docker compose up -d --build

IP=$(curl -fsS -4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "======================================================================"
echo "  Video Studio is running:  http://${IP}:8080"
echo "  Log in with the AUTH_TOKEN stored in $(pwd)/.env"
echo "  Logs:    docker compose logs -f"
echo "  Update:  git pull && docker compose up -d --build"
echo "======================================================================"
