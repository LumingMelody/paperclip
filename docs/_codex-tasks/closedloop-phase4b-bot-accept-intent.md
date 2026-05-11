You are Codex. Working repo: `/Users/melodylu/PycharmProjects/paperclip-dingtalk-bot`
(NOT the paperclip repo). Implement **Phase 4b** of the closed-loop tracking
system: a DingTalk bot intent that lets Anna reply "采纳 S1 S3" or "拒绝 S2"
on her phone to mark suggestions as accepted/rejected via paperclip API.

## Background

Phase 1-3 are live in the paperclip server (separate repo). Suggestions
have a status state machine: `proposed → accepted | rejected → measured`.
This task makes the bot understand "采纳"/"拒绝" replies in 钉钉 and PATCH
the corresponding suggestion(s) accordingly.

## Pattern reference

- `intents.py` already has plain regex Intent parser. Read it for style.
- `main.py` async `_Handler.process()` is the dispatch entry point.
- `pcl_runner.py` shows how to invoke external commands.
- This change adds direct paperclip API calls (not via pcl-tools), so a
  new tiny module `suggestions_client.py` is appropriate.

## Shell rules

**Allowed**: `cat`, `ls`, `rg`, `sed -n`, `python3 -c "import ..."` to verify modules import.
**Forbidden**: `git`, `pip`, `pnpm`, network. Claude commits + restarts the bot.

## What to do

### File 1 (create): `suggestions_client.py`

```python
"""Tiny paperclip-suggestions API client for the DingTalk bot.

Used by main.py when Anna replies '采纳 S1 S3' / '拒绝 S2' in chat. Does
NOT go through pcl-tools (suggestions are not a tool, they are a
paperclip-server entity).
"""
from __future__ import annotations

import logging
from typing import Optional

import requests

import config

logger = logging.getLogger(__name__)


class SuggestionsClientError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if config.PAPERCLIP_API_KEY:
        h["Authorization"] = f"Bearer {config.PAPERCLIP_API_KEY}"
    return h


def list_proposed(limit: int = 100) -> list[dict]:
    """Return all status='proposed' suggestions for the configured company,
    ordered by createdAt DESC (server default)."""
    url = f"{config.PAPERCLIP_API_URL}/api/companies/{config.COMPANY_ID}/suggestions"
    try:
        r = requests.get(url, params={"status": "proposed", "limit": limit}, headers=_headers(), timeout=10)
        r.raise_for_status()
    except requests.RequestException as e:
        raise SuggestionsClientError(f"GET /suggestions failed: {e}") from e
    data = r.json()
    return data.get("rows", [])


def find_by_labels(labels: list[str], limit: int = 100) -> list[dict]:
    """Find proposed suggestions matching any of the given S-labels (e.g.
    ['S1', 'S3']). For each label, returns the most-recent matching row.
    Labels with no match are silently skipped — caller should compare
    returned labels vs requested to detect misses."""
    rows = list_proposed(limit=limit)
    result: list[dict] = []
    seen_labels: set[str] = set()
    for label in labels:
        for row in rows:  # already sorted by createdAt DESC
            if row.get("sequenceLabel") == label and label not in seen_labels:
                result.append(row)
                seen_labels.add(label)
                break
    return result


def patch_status(suggestion_id: str, status: str) -> dict:
    """PATCH the suggestion status. Server auto-sets adoptedAt when
    status='accepted'."""
    if status not in ("accepted", "rejected", "dismissed"):
        raise ValueError(f"unsupported status for bot accept flow: {status}")
    url = f"{config.PAPERCLIP_API_URL}/api/suggestions/{suggestion_id}"
    try:
        r = requests.patch(url, json={"status": status}, headers=_headers(), timeout=10)
        r.raise_for_status()
    except requests.RequestException as e:
        raise SuggestionsClientError(f"PATCH /suggestions/{suggestion_id} failed: {e}") from e
    return r.json()
```

### File 2 (modify): `config.py`

Add two new env-driven config values. Insert near the existing
`COMPANY_ID = ...` block:

```python
PAPERCLIP_API_URL = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100").strip()
PAPERCLIP_API_KEY = os.environ.get("PAPERCLIP_API_KEY", "").strip()
```

(Empty `PAPERCLIP_API_KEY` is OK in local-trusted mode — server allows anon
on localhost.)

Do not change any other variable.

### File 3 (modify): `intents.py`

Append at the bottom (after the existing `parse` function and other
`_*_RE` patterns), a NEW regex + a new helper function `parse_accept`:

```python
# --- Phase 4: closed-loop suggestion accept/reject -------------------------

_ACCEPT_RE = re.compile(r"^\s*(采纳|接受|adopt|accept)\s+((?:S\d+(?:\s+|$))+)\s*$", re.IGNORECASE)
_REJECT_RE = re.compile(r"^\s*(拒绝|否决|reject|skip)\s+((?:S\d+(?:\s+|$))+)\s*$", re.IGNORECASE)


class AcceptIntent(NamedTuple):
    """Result of an accept/reject parse."""
    decision: str          # 'accepted' | 'rejected'
    labels: list[str]      # ['S1', 'S3']


def parse_accept(text: str) -> Optional[AcceptIntent]:
    """Parse '采纳 S1 S3' / '拒绝 S2' style messages. Returns None if no match."""
    text = text.strip()
    m = _ACCEPT_RE.match(text)
    if m:
        labels = [tok.upper() for tok in m.group(2).split()]
        return AcceptIntent(decision="accepted", labels=labels)
    m = _REJECT_RE.match(text)
    if m:
        labels = [tok.upper() for tok in m.group(2).split()]
        return AcceptIntent(decision="rejected", labels=labels)
    return None
```

### File 4 (modify): `main.py`

In the `_Handler.process()` method, locate the line:

```python
            intent = parse(text)
```

Insert this BEFORE that line (between the reset-command block and the
intent parse):

```python
            # 1.5) Accept/reject suggestion replies — handle BEFORE generic intent parse.
            from intents import parse_accept
            from suggestions_client import find_by_labels, patch_status, SuggestionsClientError
            accept_intent = parse_accept(text)
            if accept_intent:
                try:
                    matched = find_by_labels(accept_intent.labels)
                except SuggestionsClientError as e:
                    self.reply_markdown("⚠️ 闭环 API 失败", f"```\n{e}\n```", chatbot_msg)
                    return AckMessage.STATUS_OK, "OK"
                if not matched:
                    self.reply_markdown(
                        "🤷 没找到对应建议",
                        f"找不到 status=proposed 的 `{', '.join(accept_intent.labels)}` 建议。\n\n可能原因：\n- 已经标过了\n- 标签写错了\n- 这条建议是几周前的，已经过期",
                        chatbot_msg,
                    )
                    return AckMessage.STATUS_OK, "OK"
                outcomes: list[str] = []
                for row in matched:
                    try:
                        patch_status(row["id"], accept_intent.decision)
                        outcomes.append(f"- ✅ `{row['sequenceLabel']}` ({row['text'][:40]}...) → **{accept_intent.decision}**")
                    except SuggestionsClientError as e:
                        outcomes.append(f"- ❌ `{row['sequenceLabel']}` failed: {e}")
                missed = set(accept_intent.labels) - {row["sequenceLabel"] for row in matched}
                if missed:
                    outcomes.append(f"- ⚠️ 没找到: {', '.join(sorted(missed))}")
                emoji = "✅" if accept_intent.decision == "accepted" else "🚫"
                self.reply_markdown(
                    f"{emoji} 闭环建议已 {accept_intent.decision}",
                    "\n".join(outcomes),
                    chatbot_msg,
                )
                return AckMessage.STATUS_OK, "OK"

```

Don't change anything else in main.py.

### File 5 (modify): `.env.example`

Append two new lines after the existing `PAPERCLIP_*` block:

```
# Paperclip server API (used by suggestions_client for accept/reject of closed-loop suggestions)
PAPERCLIP_API_URL=http://127.0.0.1:3100
# Optional — leave empty for local-trusted mode (server allows anon on localhost)
PAPERCLIP_API_KEY=
```

---

## Rules

- Verbatim copy.
- Don't touch unrelated files.
- Don't `pip install requests` — already in requirements (verify with `cat requirements.txt`).

## Report

1. `wc -l suggestions_client.py`
2. `python3 -c "import suggestions_client; print('module loads')"` (should succeed if requests is installed)
3. `python3 -c "from intents import parse_accept; print(parse_accept('采纳 S1 S3'))"` (should print `AcceptIntent(decision='accepted', labels=['S1', 'S3'])`)
4. `grep -n "parse_accept\|suggestions_client" intents.py main.py`
5. Deviations (should be none).
