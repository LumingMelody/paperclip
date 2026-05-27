#!/usr/bin/env bash
# Push updated docs/agents/<name>.md prompts to the paperclip server's
# runtime agent instructions, via PUT /api/agents/:id/instructions-bundle/file.
#
# Idempotent: each PUT overwrites the runtime AGENTS.md for that agent.
# Safe to re-run after every prompt edit during Phase 5 + future iterations.
#
# Usage:
#   PAPERCLIP_COMPANY_ID=<uuid> PAPERCLIP_BASE_URL=http://127.0.0.1:3100 \
#     scripts/phase5-push-agent-prompts.sh
#
# Defaults: PAPERCLIP_BASE_URL=http://127.0.0.1:3100. COMPANY_ID is hardcoded
# to the EverPretty company seeded by the C1 migration; override only if you
# moved this script to a different paperclip instance.

set -euo pipefail

BASE="${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# name → UUID (resolved from `GET /api/companies/<id>/agents` snapshot).
# Concierge is intentionally NOT in this list — its push is handled by
# the C1 phase 1-4 flow; this script is for the 6 business agents that
# participate in Concierge's sub-issue dispatch chain.
PAIRS=(
  "finance:ffbebaee-4f54-4712-8a7b-4a06ce70d674"
  "product_sizing:af07531d-151f-4fe4-b437-7c5e34945d0f"
  "supply:960b5f82-0995-4a26-9986-c0af4d0070bb"
  "cx_ops:7f619fcd-fd0b-446d-a8af-5a50cc4cf828"
  "marketing:0f4f087f-80ad-446e-8419-4af2fd2bf703"
  "research:6ab1f6fa-0cc9-414b-9a5d-53b625137bd5"
)

fail=0
for pair in "${PAIRS[@]}"; do
  name="${pair%%:*}"
  uuid="${pair##*:}"
  src="$REPO_ROOT/docs/agents/${name}.md"

  if [ ! -f "$src" ]; then
    echo "⏭  $name: $src missing — skip" >&2
    continue
  fi

  payload="$(python3 -c "
import json, pathlib
content = pathlib.Path('$src').read_text(encoding='utf-8')
print(json.dumps({'path': 'AGENTS.md', 'content': content, 'clearLegacyPromptTemplate': False}, ensure_ascii=False))
")"

  resp_file="$(mktemp)"
  http="$(curl -sS -o "$resp_file" -w '%{http_code}' \
    -X PUT "$BASE/api/agents/$uuid/instructions-bundle/file" \
    -H 'content-type: application/json' \
    -d "$payload")"

  if [ "$http" = "200" ]; then
    echo "✅ $name (${uuid:0:8}) → HTTP 200 ($(wc -l < "$src" | tr -d ' ') lines pushed)"
  else
    echo "❌ $name (${uuid:0:8}) → HTTP $http" >&2
    cat "$resp_file" >&2; echo >&2
    fail=1
  fi
  rm -f "$resp_file"
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "One or more pushes failed; runtime is not fully in sync with source." >&2
  exit 1
fi

echo
echo "All 6 business agents pushed. Verify with:"
echo '  for u in ffbebaee... af07531d... 960b5f82... 7f619fcd... 0f4f087f... 6ab1f6fa...; do'
echo '    wc -l "/Users/melodylu/.paperclip/instances/default/companies/<companyId>/agents/$u/instructions/AGENTS.md"'
echo '  done'
