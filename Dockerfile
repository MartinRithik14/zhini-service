# ==========================================
# STAGE 1: Builder
# ==========================================
FROM node:20-slim AS builder
WORKDIR /app

# Ensure we can compile native packages if needed
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:20-slim
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app /app

EXPOSE 5000

CMD ["node", "index.js"]