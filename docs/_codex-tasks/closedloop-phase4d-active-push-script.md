You are Codex working in `/Users/melodylu/PycharmProjects/paperclip`.
Replace `scripts/paperclip-dingtalk-push.sh` (the webhook-based draft) with
a Python script that uses **DingTalk OpenAPI active push** via the existing
EverPretty 智能助手 bot's AppKey/AppSecret.

## Why

Previous design used a custom group webhook (extra robot in the group).
We switched to D1 — one bot in the group does everything. Active push uses
the existing AppKey/AppSecret to:
1. Get/cache an access token (2h TTL)
2. POST to `/v1.0/robot/groupMessages/send` with markdown payload

The script resolves `--group-name` to `openConversationId` by reading
`~/.paperclip/dingtalk_conversations.json` (written by the bot — Phase 4c).

## Shell rules

**Allowed**: `cat`, `ls`, `rg`, `sed -n`, `python3 -c "..."` for module checks.
**Forbidden**: `git`, `chmod`, `pnpm`, network. Claude commits + chmods.

## What to do

### File 1 (modify — replace entire contents): `scripts/paperclip-dingtalk-push.sh`

```bash
#!/usr/bin/env python3
"""Active push to a DingTalk group via the EverPretty 智能助手 bot's OpenAPI.

Replaces the previous custom-webhook variant. Uses the bot's AppKey/AppSecret
(same as `paperclip-dingtalk-bot/.env`) to acquire an access token, then
posts a sampleMarkdown card to a group identified by its title (resolved via
the conversation registry the bot maintains).

Env vars:
  DINGTALK_APP_KEY      — bot AppKey (= robotCode for groupMessages/send)
  DINGTALK_APP_SECRET   — bot AppSecret
  DINGTALK_PUSH_GROUP   — optional default group title

Optional override of registry file path:
  DINGTALK_CONVERSATION_REGISTRY (default: ~/.paperclip/dingtalk_conversations.json)
  DINGTALK_TOKEN_CACHE          (default: ~/.paperclip/dingtalk_token.json)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REGISTRY_PATH = Path(
    os.environ.get(
        "DINGTALK_CONVERSATION_REGISTRY",
        os.path.expanduser("~/.paperclip/dingtalk_conversations.json"),
    )
)
TOKEN_CACHE = Path(
    os.environ.get(
        "DINGTALK_TOKEN_CACHE",
        os.path.expanduser("~/.paperclip/dingtalk_token.json"),
    )
)
TOKEN_TTL_SAFETY_SEC = 60


def fail(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def _post_json(url: str, body: dict, headers: dict) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {body_text}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"network error to {url}: {e}") from e


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {body_text}") from e


def get_access_token(app_key: str, app_secret: str) -> str:
    """Cache and return a DingTalk access token. Refresh if expiring within
    TOKEN_TTL_SAFETY_SEC seconds."""
    now = int(time.time())
    if TOKEN_CACHE.exists():
        try:
            cached = json.loads(TOKEN_CACHE.read_text())
            if cached.get("app_key") == app_key and cached.get("expires_at", 0) - now > TOKEN_TTL_SAFETY_SEC:
                return cached["access_token"]
        except Exception:
            pass

    result = _post_json(
        "https://api.dingtalk.com/v1.0/oauth2/accessToken",
        {"appKey": app_key, "appSecret": app_secret},
        headers={},
    )
    token = result.get("accessToken")
    expire_in = int(result.get("expireIn", 7200))
    if not token:
        raise RuntimeError(f"unexpected token response: {result}")

    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(json.dumps({
        "app_key": app_key,
        "access_token": token,
        "expires_at": now + expire_in,
    }))
    return token


def resolve_conversation_id(group_name: str) -> tuple[str, str]:
    if not REGISTRY_PATH.exists():
        fail(
            f"Conversation registry not found at {REGISTRY_PATH}. "
            "Has the bot received any message yet in the target group? "
            "Once Anna or any member @-messages the bot in the group, the "
            "registry is auto-populated."
        )
    data = json.loads(REGISTRY_PATH.read_text())
    if group_name not in data:
        known = ", ".join(data.keys()) or "(none)"
        fail(f"Group '{group_name}' not in registry. Known groups: {known}")
    entry = data[group_name]
    conv_id = entry["id"]
    conv_type = entry.get("type", "")
    if conv_type != "2":
        fail(f"Group '{group_name}' is type={conv_type!r}, not a group chat (type=2)")
    return conv_id, entry.get("robot_code", "")


def push_markdown(conversation_id: str, title: str, text: str, app_key: str, app_secret: str,
                  robot_code: str | None) -> dict:
    token = get_access_token(app_key, app_secret)
    body = {
        "robotCode": robot_code or app_key,
        "openConversationId": conversation_id,
        "msgKey": "sampleMarkdown",
        "msgParam": json.dumps({"title": title, "text": text}, ensure_ascii=False),
    }
    return _post_json(
        "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
        body,
        headers={"x-acs-dingtalk-access-token": token},
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Active push to a DingTalk group via the EverPretty 智能助手 bot's OpenAPI.",
    )
    parser.add_argument("--title", required=True, help="Markdown card title")
    parser.add_argument("--text", help="Markdown body. If omitted and stdin is piped, reads from stdin.")
    parser.add_argument("--group-name", default=os.environ.get("DINGTALK_PUSH_GROUP", ""),
                        help="Group title as known to the bot. Defaults to $DINGTALK_PUSH_GROUP.")
    parser.add_argument("--conversation-id",
                        help="Direct openConversationId, bypasses the registry lookup.")
    parser.add_argument("--issue-id", default=os.environ.get("PAPERCLIP_TASK_ID", ""),
                        help="Optional paperclip issue id to append as footer.")
    parser.add_argument("--list-groups", action="store_true",
                        help="List known groups from registry and exit.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the resolved request and exit without POSTing.")
    args = parser.parse_args()

    if args.list_groups:
        if not REGISTRY_PATH.exists():
            print("(registry empty — bot has not received any message yet)")
            return
        data = json.loads(REGISTRY_PATH.read_text())
        for title, entry in data.items():
            print(f"  {title:30}  id={entry['id']}  type={entry.get('type')}  last_seen={entry.get('last_seen')}")
        return

    text = args.text
    if text is None:
        if not sys.stdin.isatty():
            text = sys.stdin.read()
        else:
            fail("Missing --text and stdin is a terminal")
    if args.issue_id:
        text = f"{text}\n\n---\nIssue: paperclip://issues/{args.issue_id}"

    if args.conversation_id:
        conv_id = args.conversation_id
        robot_code = ""
    else:
        if not args.group_name:
            fail("Must pass --group-name (or --conversation-id, or set DINGTALK_PUSH_GROUP env)")
        conv_id, robot_code = resolve_conversation_id(args.group_name)

    if args.dry_run:
        print(json.dumps({
            "conversationId": conv_id,
            "robotCode": robot_code,
            "title": args.title,
            "text": text,
        }, ensure_ascii=False, indent=2))
        return

    app_key = os.environ.get("DINGTALK_APP_KEY", "").strip()
    app_secret = os.environ.get("DINGTALK_APP_SECRET", "").strip()
    if not app_key or not app_secret:
        fail("Missing DINGTALK_APP_KEY or DINGTALK_APP_SECRET env vars (use the bot's credentials)")

    try:
        result = push_markdown(conv_id, args.title, text, app_key, app_secret, robot_code or None)
    except RuntimeError as e:
        fail(str(e), code=2)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

(yes the shebang line says `python3` not `bash` — the `.sh` extension is kept only because the 5 routine AGENTS.md already reference it; renaming would force an out-of-repo doc rewrite cycle.)

---

## Rules

- Replace entire contents of the existing file. Don't preserve old bash logic.
- Don't chmod. Claude does that.
- Don't touch any other file.

## Report

1. `wc -l scripts/paperclip-dingtalk-push.sh`
2. `head -1 scripts/paperclip-dingtalk-push.sh` — must show `#!/usr/bin/env python3`
3. `python3 -c "exec(open('scripts/paperclip-dingtalk-push.sh').read())"` — should error cleanly on missing args (i.e. the module loads, argparse trips on no args)
   - Actually that runs main(); use `python3 scripts/paperclip-dingtalk-push.sh --help` instead — should print usage
4. `python3 scripts/paperclip-dingtalk-push.sh --list-groups` — prints registry contents or "(registry empty ...)"
5. Deviations (should be none).
