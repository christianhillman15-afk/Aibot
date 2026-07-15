FROM node:22-bookworm-slim

# ffmpeg + ffprobe assemble explainer videos and burn captions;
# the DejaVu font is what ffmpeg's drawtext uses for burned-in captions.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
