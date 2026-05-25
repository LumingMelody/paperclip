#!/usr/bin/env bash
# Idempotently upsert the Concierge agent into the local paperclip dev server.
#
# Usage:
#   PAPERCLIP_COMPANY_ID=<uuid> PAPERCLIP_BASE_URL=http://127.0.0.1:3100 \
#     scripts/seed-concierge-agent.sh
#
# Prints the Concierge agent UUID to stdout — pipe into the bot's
# PAPERCLIP_CONCIERGE_AGENT_ID env var and into paperclip server's env.

set -euo pipefail

BASE="${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:?PAPERCLIP_COMPANY_ID required}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$REPO_ROOT/docs/agents/concierge.md"
[ -f "$PROMPT_FILE" ] || { echo "missing $PROMPT_FILE" >&2; exit 1; }

# Look up existing Concierge by exact name match.
EXISTING_ID="$(curl -fsS "$BASE/api/companies/$COMPANY_ID/agents" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(a['id']) for a in d if a.get('name')=='Concierge']" \
  | head -n1)"

if [ -n "$EXISTING_ID" ]; then
  echo "[seed] Concierge already exists: $EXISTING_ID" >&2
  echo "$EXISTING_ID"
  exit 0
fi

# Build the create body. instructionsBundle.files is a JSON object {filename: content}.
PROMPT_JSON="$(python3 -c "
import json, pathlib
content = pathlib.Path('$PROMPT_FILE').read_text(encoding='utf-8')
print(json.dumps({
    'name': 'Concierge',
    'role': 'general',
    'title': 'Concierge / DingTalk gateway',
    'capabilities': 'Routes DingTalk chat messages and answers using 22 data tools (lingxing/dws/meta/shopify/spapi/oms/rag). Writes final markdown answers as issue_comments and sets issue.status=done so the bot can short-poll.',
    'adapterType': 'claude_local',
    'adapterConfig': {
        'model': 'claude-sonnet-4-6',
        'graceSec': 15,
        'timeoutSec': 0,
        'maxTurnsPerRun': 1000,
    },
    'instructionsBundle': {
        'entryFile': 'AGENTS.md',
        'files': {'AGENTS.md': content},
    },
    'budgetMonthlyCents': 0,
}, ensure_ascii=False))
")"

RESP_FILE="$(mktemp)"
HTTP="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' \
  -XPOST "$BASE/api/companies/$COMPANY_ID/agents" \
  -H 'content-type: application/json' \
  -d "$PROMPT_JSON")"

if [ "$HTTP" != "201" ] && [ "$HTTP" != "200" ]; then
  echo "[seed] POST /api/companies/$COMPANY_ID/agents → HTTP $HTTP" >&2
  cat "$RESP_FILE" >&2; echo >&2
  exit 1
fi

NEW_ID="$(python3 -c "import json,sys; print(json.load(open('$RESP_FILE')).get('id',''))")"
[ -n "$NEW_ID" ] || { echo "[seed] create response missing id" >&2; cat "$RESP_FILE" >&2; exit 1; }
echo "[seed] Concierge created: $NEW_ID" >&2
echo "$NEW_ID"
