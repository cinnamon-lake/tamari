FROM node:22-alpine

# glibc compatibility for native modules (libsql, etc.)
# tini for proper signal handling
RUN apk add --no-cache gcompat tini

WORKDIR /app

# ── Layer cache: copy workspace manifests FIRST ──
COPY package.json package-lock.json ./
COPY packages/types/package.json ./packages/types/
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install ALL deps (dev included — needed for TypeScript/Vite build)
# --ignore-scripts prevents workspace prepare scripts from firing before src is copied.
RUN npm ci --no-audit --no-fund --loglevel=error --no-progress --ignore-scripts

# ── Copy source, run lifecycle scripts, then build ──
COPY . .
RUN npm rebuild && npm run build

# Strip dev dependencies to shrink the image
RUN npm prune --omit=dev

# Runtime env
ENV NODE_ENV=production
ENV DATA_DIR=/app/data-v2
ENV PORT=8000

# Data volume mount-point
RUN mkdir -p /app/data-v2

EXPOSE 8000

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/dist/main.js"]
