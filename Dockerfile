# ── Stage 1: dependency install ──────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests only — lets Docker cache this layer until they change
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security.
# Keep UID/GID explicit so host bind-mounted data can be chowned predictably.
ARG APP_UID=10001
ARG APP_GID=10001
RUN addgroup -S -g ${APP_GID} appgroup \
    && adduser -S -D -H -u ${APP_UID} -G appgroup appuser

WORKDIR /app

# Copy installed modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY server.js getProfileData.js ./
COPY public ./public
COPY data/settings-seed.json ./data/settings-seed.json

# Create writable data directories and give ownership to the app user
RUN mkdir -p data/datasets data/pipelines data/dropzones data/assets uploads \
    && chown -R appuser:appgroup /app

USER appuser

# Expose the default port (overridden at runtime via PORT env var)
EXPOSE 3001

# Health check — matches the /api/health endpoint in server.js
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/api/health || exit 1

ENV NODE_ENV=production

CMD ["node", "server.js"]
