FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY migrations ./migrations
RUN npm ci --no-audit --no-fund \
  && npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
  GCT_DATA_DIR=/app/.local-data \
  GCT_MIGRATIONS_DIR=/app/migrations \
  GCT_FRONTEND_DIST_DIR=/app/apps/frontend/dist \
  GCT_FRONTEND_PORT=17840 \
  GCT_FRONTEND_ORIGIN=http://127.0.0.1:17840 \
  GCT_DISABLE_OS_KEYCHAIN=1 \
  GCT_CREDENTIAL_ENV_PATH=/app/.local-data/credentials.env
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/.local-data && chown node:node /app/.local-data && chmod 700 /app/.local-data
USER node
EXPOSE 17840
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:17840/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/backend/dist/server.js"]
