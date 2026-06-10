#!/usr/bin/env bash
# paperclip dev launcher (for launchd).
#
# Clears the local-service-supervisor registry first to avoid the
# "stale pid + port refuses to bind" trap documented in the
# paperclip-dev-stale-registry-after-crash skill, then exec's pnpm dev.
set -euo pipefail

cd "$(dirname "$0")/.."
HERE="$(pwd)"

# launchd children never see shell-rcfile PATH mutations. Prepend:
#  - ~/.local/bin: claude CLI native installer location (agent child processes
#    spawned by the server resolve `claude` from this process's PATH)
#  - latest nvm node bin: survives node upgrades, unlike a hardcoded version
NODE_BIN=$(ls -td "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | head -1)
export PATH="$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

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
exec pnpm dev
