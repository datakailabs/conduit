# Conduit — Multi-stage production build
# Produces a minimal, non-root container for the GraphRAG API.

# ─── Stage 1: Build ─────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY api ./api
COPY src ./src
RUN npm run build

# ─── Stage 2: Production ────────────────────────────────────────────
FROM node:20-alpine

# Security: install dumb-init for proper PID 1 signal handling,
# then drop to non-root user
RUN apk add --no-cache dumb-init \
    && addgroup -g 1001 conduit \
    && adduser -u 1001 -G conduit -s /bin/sh -D conduit

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/api ./dist/api

# Set ownership and drop privileges
RUN chown -R conduit:conduit /app
USER conduit

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/server.js"]
