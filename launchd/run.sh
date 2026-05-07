#!/usr/bin/env bash
# paperclip dev launcher (for launchd).
#
# Clears the local-service-supervisor registry first to avoid the
# "stale pid + port refuses to bind" trap documented in the
# paperclip-dev-stale-registry-after-crash skill, then exec's pnpm dev.
set -euo pipefail

cd "$(dirname "$0")/.."
HERE="$(pwd)"

# Best-effort: clear any stale dev-service registration that would otherwise
# refuse a fresh `pnpm dev` start. Errors here are non-fatal.
echo "[run.sh] clearing any stale dev-service registry..."
pnpm --silent --filter @paperclipai/server exec tsx ../scripts/dev-service.ts stop 2>/dev/null || true

# Kill any lingering pnpm dev / dev-watch under this repo.
PATTERN="${HERE}/node_modules/.pnpm/.*tsx.*dev"
pkill -f "node.*paperclip.*dev-watch" 2>/dev/null || true
pkill -f "node.*paperclip.*dev-runner" 2>/dev/null || true
sleep 1

echo "[run.sh] starting pnpm dev from ${HERE}"
exec /Users/melodylu/.nvm/versions/node/v24.13.0/bin/pnpm dev
