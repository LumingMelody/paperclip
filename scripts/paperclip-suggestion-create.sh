#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-suggestion-create.sh \
    --label S1 \
    --text "改 EE41981 尺码表加体重对照" \
    --tool dws.returnReasons \
    --args '{"shop":"EP-US","since":"2026-05-03"}' \
    --extract 'rows[?returnReason==`too small`].returnCount | sum(@)' \
    --direction decrease \
    --baseline 38 \
    --baseline-date 2026-05-10 \
    [--follow-up-days 28] \
    [--issue-id <uuid>] \
    [--agent-id <uuid>] \
    [--company-id <uuid>] \
    [--dry-run]

Defaults:
  --issue-id        $PAPERCLIP_TASK_ID
  --agent-id        $PAPERCLIP_AGENT_ID
  --company-id      $PAPERCLIP_COMPANY_ID
  --follow-up-days  28

POSTs to: $PAPERCLIP_API_URL/api/companies/<companyId>/suggestions

Used by routine agents to register a structured S1/S2/S3 suggestion bound to a
re-runnable metric query, so the closed-loop checker can later replay the query
and post the outcome.
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

label=""
text=""
tool_id=""
args_json=""
extract=""
direction=""
baseline=""
baseline_date=""
follow_up_days="28"
issue_id="${PAPERCLIP_TASK_ID:-}"
agent_id="${PAPERCLIP_AGENT_ID:-}"
company_id="${PAPERCLIP_COMPANY_ID:-}"
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) label="${2:-}"; shift 2 ;;
    --text) text="${2:-}"; shift 2 ;;
    --tool) tool_id="${2:-}"; shift 2 ;;
    --args) args_json="${2:-}"; shift 2 ;;
    --extract) extract="${2:-}"; shift 2 ;;
    --direction) direction="${2:-}"; shift 2 ;;
    --baseline) baseline="${2:-}"; shift 2 ;;
    --baseline-date) baseline_date="${2:-}"; shift 2 ;;
    --follow-up-days) follow_up_days="${2:-}"; shift 2 ;;
    --issue-id) issue_id="${2:-}"; shift 2 ;;
    --agent-id) agent_id="${2:-}"; shift 2 ;;
    --company-id) company_id="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

missing=()
[[ -z "$label" ]] && missing+=("--label")
[[ -z "$text" ]] && missing+=("--text")
[[ -z "$tool_id" ]] && missing+=("--tool")
[[ -z "$args_json" ]] && missing+=("--args")
[[ -z "$extract" ]] && missing+=("--extract")
[[ -z "$direction" ]] && missing+=("--direction")
[[ -z "$baseline" ]] && missing+=("--baseline")
[[ -z "$baseline_date" ]] && missing+=("--baseline-date")
[[ -z "$issue_id" ]] && missing+=("--issue-id (or set PAPERCLIP_TASK_ID)")
[[ -z "$agent_id" ]] && missing+=("--agent-id (or set PAPERCLIP_AGENT_ID)")
[[ -z "$company_id" ]] && missing+=("--company-id (or set PAPERCLIP_COMPANY_ID)")

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'Missing required args: %s\n' "${missing[*]}" >&2
  usage >&2
  exit 1
fi

if [[ "$direction" != "decrease" && "$direction" != "increase" ]]; then
  printf '--direction must be "decrease" or "increase", got: %s\n' "$direction" >&2
  exit 1
fi

require_command jq

payload="$(
  jq -nc \
    --arg issue "$issue_id" \
    --arg agent "$agent_id" \
    --arg label "$label" \
    --arg text "$text" \
    --arg tool "$tool_id" \
    --argjson args "$args_json" \
    --arg extract "$extract" \
    --arg direction "$direction" \
    --argjson baseline "$baseline" \
    --arg baseline_date "$baseline_date" \
    --argjson follow_up_days "$follow_up_days" \
    '{
      sourceIssueId: $issue,
      sourceAgentId: $agent,
      sequenceLabel: $label,
      text: $text,
      metric: {
        toolId: $tool,
        args: $args,
        extract: $extract,
        direction: $direction
      },
      baselineValue: $baseline,
      baselineDate: $baseline_date,
      followUpDays: $follow_up_days
    }'
)"

if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" ]]; then
  printf 'Missing PAPERCLIP_API_URL or PAPERCLIP_API_KEY env vars.\n' >&2
  exit 1
fi

run_id_header=()
if [[ -n "${PAPERCLIP_RUN_ID:-}" ]]; then
  run_id_header=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")
fi

curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/companies/$company_id/suggestions" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "${run_id_header[@]}" \
  -H 'Content-Type: application/json' \
  --data-binary "$payload"
