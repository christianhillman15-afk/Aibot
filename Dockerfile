FROM node:22-bookworm-slim

# Tools available to the AI's bash tool inside the container sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git curl ca-certificates jq python3 ripgrep openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
