#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-dingtalk-push.sh \
    --title "Marketing 周报 5/11" \
    --text "...markdown body..." \
    [--issue-id <uuid>] \
    [--dry-run]

Reads markdown body from stdin if `--text` is not given.

Env vars:
  DINGTALK_WEBHOOK_URL       — custom robot webhook URL (no timestamp/sign appended)
  DINGTALK_WEBHOOK_SECRET    — HMAC secret from the robot setup screen
  PAPERCLIP_TASK_ID          — optional, used as default --issue-id

POSTs a signed `msgtype=markdown` card to the DingTalk webhook. Used by
routine agents to push their weekly report (with S1/S2/S3 suggestions) to
Anna's group so she can reply "采纳 S1 S3" on her phone.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { printf 'Missing command: %s\n' "$1" >&2; exit 1; }
}

title=""
text=""
issue_id="${PAPERCLIP_TASK_ID:-}"
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) title="${2:-}"; shift 2 ;;
    --text) text="${2:-}"; shift 2 ;;
    --issue-id) issue_id="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown arg: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$title" ]]; then
  printf 'Missing --title\n' >&2
  exit 1
fi

if [[ -z "$text" ]]; then
  if [[ ! -t 0 ]]; then
    text="$(cat)"
  else
    printf 'Missing --text and stdin is a terminal\n' >&2
    exit 1
  fi
fi

# Append a footer with issue link if we have an issue id and prefix can be guessed.
if [[ -n "$issue_id" ]]; then
  text="$text"$'\n\n---\nIssue: paperclip://issues/'"$issue_id"
fi

require_command jq

if [[ "$dry_run" == "1" ]]; then
  payload="$(jq -nc --arg title "$title" --arg text "$text" \
    '{msgtype: "markdown", markdown: {title: $title, text: $text}}')"
  printf '[DRY-RUN] would POST to: %s\n' "${DINGTALK_WEBHOOK_URL:-(unset)}"
  printf '%s\n' "$payload"
  exit 0
fi

if [[ -z "${DINGTALK_WEBHOOK_URL:-}" || -z "${DINGTALK_WEBHOOK_SECRET:-}" ]]; then
  printf 'Missing DINGTALK_WEBHOOK_URL or DINGTALK_WEBHOOK_SECRET env vars.\n' >&2
  exit 1
fi

require_command openssl
require_command python3

timestamp_ms="$(python3 -c 'import time; print(int(time.time()*1000))')"
string_to_sign="${timestamp_ms}
${DINGTALK_WEBHOOK_SECRET}"

# HMAC-SHA256, base64, then url-encode
sign_b64="$(printf '%s' "$string_to_sign" | openssl dgst -sha256 -hmac "$DINGTALK_WEBHOOK_SECRET" -binary | base64)"
sign_urlenc="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote_plus(sys.argv[1]))" "$sign_b64")"

signed_url="${DINGTALK_WEBHOOK_URL}&timestamp=${timestamp_ms}&sign=${sign_urlenc}"

payload="$(jq -nc --arg title "$title" --arg text "$text" \
  '{msgtype: "markdown", markdown: {title: $title, text: $text}}')"

curl -sS -X POST "$signed_url" \
  -H 'Content-Type: application/json' \
  --data-binary "$payload"
