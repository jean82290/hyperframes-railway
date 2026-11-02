# HyperFrames render API for Railway.
# Same rendering stack as the upstream production image: pinned chrome-headless-shell
# (deterministic BeginFrame capture), pinned FFmpeg, and the full Noto font set.
# Linux amd64 only (Chrome for Testing does not ship linux-arm64 builds).

FROM node:22.23.4-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip xz-utils \
    libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
    libcups2 libasound2 libpangocairo-1.0-0 libxshmfence1 libgtk-3-0 \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core fonts-noto-extra \
    fonts-noto-ui-core fonts-freefont-ttf fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

# FFmpeg: the static build HyperFrames pins upstream (BtbN n8.0.1), checksum-verified.
ARG FFMPEG_RELEASE=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-02-28-12-59
ARG FFMPEG_BUILD=ffmpeg-n8.0.1-66-g27b8d1a017
ARG FFMPEG_SHA256=26d2ecd0cefba99f9d1ea92252a3a4f743a58df4c1c3cf9f8bbaaa40b1fca5b0
RUN curl -fsSL -o /tmp/ffmpeg.tar.xz "$FFMPEG_RELEASE/$FFMPEG_BUILD-linux64-gpl-8.0.tar.xz" \
 && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe' \
 && rm /tmp/ffmpeg.tar.xz \
 && ffmpeg -version | head -1

# chrome-headless-shell: the build HyperFrames tests its renderer against.
ARG CHROME_HEADLESS_SHELL_VERSION=152.0.7977.30
RUN npx --yes @puppeteer/browsers@3.2.6 install chrome-headless-shell@${CHROME_HEADLESS_SHELL_VERSION} --path /opt/puppeteer \
 && CHS="$(find /opt/puppeteer/chrome-headless-shell -name chrome-headless-shell -type f | head -n1)" \
 && mkdir -p /opt/chrome && ln -s "$CHS" /opt/chrome/chrome-headless-shell \
 && /opt/chrome/chrome-headless-shell --version \
 && rm -rf /root/.npm

ENV HYPERFRAMES_CHROME_PATH=/opt/chrome/chrome-headless-shell \
    PRODUCER_HEADLESS_SHELL_PATH=/opt/chrome/chrome-headless-shell \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CONTAINER=true \
    NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src

EXPOSE 8080
CMD ["node", "src/server.js"]
