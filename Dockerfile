# Two stages: build the UI with dev dependencies, then a slim runtime image without them.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
# Demo image: show the demo sign-in buttons. A production build would leave this unset.
ARG VITE_DEMO_KEYS=true
RUN VITE_DEMO_KEYS=$VITE_DEMO_KEYS npm run build -w apps/web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    LOG_FORMAT=json
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# tsx (a runtime dependency of apps/api) runs the TypeScript sources directly.
RUN npm ci --omit=dev && npm cache clean --force
COPY packages/core/src packages/core/src
COPY apps/api/src apps/api/src
COPY config config
COPY fixtures/partners.json fixtures/partners.json
COPY --from=build /app/apps/web/dist apps/web/dist

# Run as the unprivileged "node" user; only /data is writable.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form so SIGTERM reaches node directly (graceful shutdown)
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
