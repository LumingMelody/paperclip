#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run uvicorn paperclip_rag.api:create_app --factory \
    --host "${PAPERCLIP_RAG_HOST:-127.0.0.1}" \
    --port "${PAPERCLIP_RAG_PORT:-9001}" \
    --log-level info
