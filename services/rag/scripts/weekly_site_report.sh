#!/usr/bin/env bash
# Weekly Shopify independent-site return report wrapper, invoked by launchd.
#
# - Exports DWS_DB_* from ~/.paperclip/tool-secrets.json (same pattern as
#   weekly_report.sh).
# - DingTalk creds are resolved by weekly_site_return_report.py itself from
#   ~/.paperclip/dingtalk-channels.json (default --channel concierge), so no
#   DINGTALK_* exports are needed here.
set -euo pipefail

export NO_PROXY=*
export no_proxy=*

REPO=/Users/melodylu/PycharmProjects/paperclip
cd "$REPO/services/rag"

eval "$(/usr/bin/env python3 - <<'PY'
import json
from pathlib import Path

secrets_path = Path("/Users/melodylu/.paperclip/tool-secrets.json")
try:
    secrets = json.loads(secrets_path.read_text(encoding="utf-8"))
    dws = list(secrets["companies"].values())[0]["dws"]
except Exception as exc:
    raise SystemExit(f"missing DWS credentials in {secrets_path}: {exc}")

for k in ("host", "port", "user", "password", "database"):
    print(f"export DWS_DB_{k.upper()}={dws[k]!r}")
PY
)"

echo "[weekly_site_report] starting weekly site return report $*"
exec /Users/melodylu/.local/bin/uv run python scripts/weekly_site_return_report.py "$@"
