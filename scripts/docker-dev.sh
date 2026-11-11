#!/bin/sh
# Entry point of the dev container (compose.dev.yaml).
# Installs dependencies into the container's own node_modules volumes when package-lock.json
# changed, then runs the normal live-reload dev setup (Vite + tsx watch).
set -e
cd "${APP_DIR:-/app}"
STAMP=node_modules/.docker-dev-lock
if [ ! -f "$STAMP" ] || ! cmp -s package-lock.json "$STAMP"; then
  echo "[docker-dev] installing dependencies (package-lock.json changed)…"
  # npm install, not npm ci: ci deletes node_modules, which is a mounted volume here.
  # Keep the host's package-lock.json byte-for-byte (npm may reformat it on another platform).
  cp package-lock.json /tmp/package-lock.json
  npm install --no-audit --no-fund
  cp /tmp/package-lock.json package-lock.json
  cp package-lock.json "$STAMP"
fi
exec npm run dev
