#!/usr/bin/env bash
# Weekly return report wrapper, invoked by launchd.
#
# - Exports DWS_DB_* from ~/.paperclip/tool-secrets.json using the same pattern
#   as cron_ingest.sh.
# - Exports DingTalk app credentials from the existing DingTalk bot launchd plist,
#   falling back to ~/.paperclip/tool-secrets.json when present there.
# - Leaves report generation/push semantics to weekly_return_report.py.
set -euo pipefail

export NO_PROXY=*
export no_proxy=*

REPO=/Users/melodylu/PycharmProjects/paperclip
cd "$REPO/services/rag"

eval "$(/usr/bin/env python3 - <<'PY'
import json
import os
import plistlib
from pathlib import Path

home = Path("/Users/melodylu")
secrets_path = home / ".paperclip" / "tool-secrets.json"
bot_plist = home / "Library" / "LaunchAgents" / "com.everpretty.dingtalk-bot.plist"

def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}

def find_normalized(obj, names):
    if isinstance(obj, dict):
        for key, value in obj.items():
            normalized = str(key).replace("-", "_").lower()
            if normalized in names and value:
                return str(value)
        for value in obj.values():
            found = find_normalized(value, names)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_normalized(item, names)
            if found:
                return found
    return None

def find_in_named_section(obj, section_hint, names):
    if isinstance(obj, dict):
        for key, value in obj.items():
            normalized = str(key).replace("-", "_").lower()
            if section_hint in normalized:
                found = find_normalized(value, names)
                if found:
                    return found
            found = find_in_named_section(value, section_hint, names)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_in_named_section(item, section_hint, names)
            if found:
                return found
    return None

secrets = load_json(secrets_path)
try:
    dws = list(secrets["companies"].values())[0]["dws"]
except Exception as exc:
    raise SystemExit(f"missing DWS credentials in {secrets_path}: {exc}")

for k in ("host", "port", "user", "password", "database"):
    print(f"export DWS_DB_{k.upper()}={dws[k]!r}")

plist_env = {}
try:
    with bot_plist.open("rb") as f:
        plist_env = plistlib.load(f).get("EnvironmentVariables", {})
except FileNotFoundError:
    plist_env = {}

# Bot reads creds from its .env (loaded by python-dotenv in config.py).
bot_dotenv = {}
bot_env_path = home / "PycharmProjects" / "paperclip-dingtalk-bot" / ".env"
try:
    for line in bot_env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        bot_dotenv[k.strip()] = v.strip().strip('"').strip("'")
except FileNotFoundError:
    pass

# Post-migration (2026-05-27 single-bot -> multi-channel) single source of truth.
# ~/.paperclip/dingtalk-channels.json is a FLAT dict keyed by channel name (NOT
# nested under "channels"); it is maintained by the live bot + server broadcaster.
# The old single-bot plist was archived and paperclip-dingtalk-bot/.env removed,
# so the three legacy sources below now resolve to empty — this is the only
# working cred source for the launchd-driven weekly report. Use the CONCIERGE
# channel: the pusher sets robotCode=app_key and concierge is the robot
# registered for the target group (dingtalk_conversations.json).
channels = load_json(home / ".paperclip" / "dingtalk-channels.json")
concierge = channels.get("concierge", {}) if isinstance(channels, dict) else {}

app_key = (
    os.environ.get("DINGTALK_APP_KEY")
    or concierge.get("app_key")
    or plist_env.get("DINGTALK_APP_KEY")
    or bot_dotenv.get("DINGTALK_APP_KEY")
    or find_normalized(secrets, {"dingtalk_app_key"})
    or find_in_named_section(secrets, "dingtalk", {"app_key", "appkey", "key"})
)
app_secret = (
    os.environ.get("DINGTALK_APP_SECRET")
    or concierge.get("app_secret")
    or plist_env.get("DINGTALK_APP_SECRET")
    or bot_dotenv.get("DINGTALK_APP_SECRET")
    or find_normalized(secrets, {"dingtalk_app_secret"})
    or find_in_named_section(secrets, "dingtalk", {"app_secret", "appsecret", "secret"})
)
if app_key:
    print(f"export DINGTALK_APP_KEY={app_key!r}")
if app_secret:
    print(f"export DINGTALK_APP_SECRET={app_secret!r}")
PY
)"

echo "[weekly_report] starting weekly return report $*"
exec /Users/melodylu/.local/bin/uv run python scripts/weekly_return_report.py "$@"
