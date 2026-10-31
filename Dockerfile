# Build stage: compiles better-sqlite3's native module.
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Debian's Chromium is used at runtime; skip Puppeteer's own download.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime stage: no compilers, runs as the unprivileged `node` user (uid 1000).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production DATA_DIR=/data PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY examples ./examples
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/main.js"]
