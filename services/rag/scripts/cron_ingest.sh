#!/usr/bin/env bash
# Daily incremental RAG ingest cron wrapper, invoked by launchd.
#
# - Sources DWS DB creds from ~/.paperclip/tool-secrets.json (the ingest reads
#   os.environ directly and does NOT auto-source .env).
# - --since = 14d ago (manifest dedups anything already ingested; 14d covers
#   sleep/skip gaps).
# - --per-group 8 keeps the stratified (sku_left7, returnReason) sampling.
# - Aborts (no-op) if the RAG service at :9001 is not reachable.
#
# launchd plist: launchd/com.everpretty.paperclip-rag-ingest.plist
set -euo pipefail

REPO=/Users/melodylu/PycharmProjects/paperclip
cd "$REPO/services/rag"

API=http://127.0.0.1:9001
if ! curl -sf --max-time 5 "$API/collections" >/dev/null; then
  echo "[cron_ingest] RAG service at $API not reachable — skipping run"
  exit 0
fi

# Export DWS_DB_* from tool-secrets.json (set -a auto-exports vars assigned in this block).
eval "$(/usr/bin/env python3 - <<'PY'
import json
d = json.load(open('/Users/melodylu/.paperclip/tool-secrets.json'))
dws = list(d['companies'].values())[0]['dws']
for k in ('host', 'port', 'user', 'password', 'database'):
    print(f"export DWS_DB_{k.upper()}={dws[k]!r}")
PY
)"

SINCE=$(date -v-14d +%Y-%m-%d)

echo "[cron_ingest] starting incremental ingest since=$SINCE per-group=8"
exec /Users/melodylu/.local/bin/uv run python -m paperclip_rag.ingest.refund_comments_all \
  --since "$SINCE" \
  --per-group 8 \
  --collection refund_comments \
  --account-pattern 'AmazonEP%'
