# syntax=docker/dockerfile:1.4

# ==========================================
# STAGE 1: Builder
# ==========================================
FROM node:20-slim AS builder

WORKDIR /app

# Install build tools only for native modules
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy only dependency files first (better layer caching)
COPY package.json package-lock.json* ./

# Use BuildKit cache for npm → much faster on repeated builds
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Now copy the rest of the source
COPY . .

# ==========================================
# STAGE 2: Production
# ==========================================
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production

# Copy only what is needed for runtime
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app ./

EXPOSE 5000

CMD ["node", "index.js"]