You are Codex working in `/Users/melodylu/PycharmProjects/paperclip-dingtalk-bot`.
Implement **D1 — bot conversation registry** so external scripts can
look up DingTalk group conversation IDs by name to send active pushes.

## Why

We're switching from "custom group webhook" (extra robot in the group) to
"active push via the existing EverPretty 智能助手 bot's OpenAPI". The
OpenAPI needs `openConversationId` which the bot receives on every inbound
message as `chatbot_msg.conversation_id`. We need to persist a mapping
`{conversation_title: {id, type, last_seen}}` to a JSON file so external
push scripts (paperclip-dingtalk-push.sh) can resolve group name → id
without dragging in DingTalk credentials.

## Shell rules

**Allowed**: `cat`, `ls`, `rg`, `sed -n`, `python3 -c "import json; ..."` for module-load checks.
**Forbidden**: `git`, `pip install`, network. Claude commits + restarts bot.

## What to do

### File 1 (create): `conversation_registry.py`

```python
"""DingTalk conversation registry — persists known groups to a JSON file
so external push scripts can resolve group name → openConversationId.

Single source of truth for active-push routing. Bot writes; scripts read.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


REGISTRY_PATH = Path(
    os.environ.get(
        "DINGTALK_CONVERSATION_REGISTRY",
        os.path.expanduser("~/.paperclip/dingtalk_conversations.json"),
    )
)


def _load() -> dict[str, dict[str, Any]]:
    if not REGISTRY_PATH.exists():
        return {}
    try:
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("conversation registry unreadable, starting fresh: %s", e)
        return {}


def _save_atomic(data: dict[str, dict[str, Any]]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="conv_reg_", suffix=".json", dir=str(REGISTRY_PATH.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, REGISTRY_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def record(conversation_id: Optional[str], conversation_title: Optional[str],
           conversation_type: Optional[str], robot_code: Optional[str] = None) -> None:
    """Upsert a single conversation entry. Safe to call on every inbound message."""
    if not conversation_id or not conversation_title:
        return  # not enough to index
    data = _load()
    data[conversation_title] = {
        "id": conversation_id,
        "type": conversation_type or "",
        "robot_code": robot_code or "",
        "last_seen": datetime.now(timezone.utc).isoformat(),
    }
    _save_atomic(data)


def lookup(title: str) -> Optional[dict[str, Any]]:
    """Look up a conversation by exact title. Returns None if not seen yet."""
    return _load().get(title)


def list_all() -> dict[str, dict[str, Any]]:
    return _load()
```

### File 2 (modify): `main.py`

In `_Handler.process()`, right after the line:
```python
            text = (chatbot_msg.text and chatbot_msg.text.content or "").strip()
```

Insert this block (3 lines body + 1 try/except wrapper for safety):

```python
            # Record this conversation so external push scripts can resolve it.
            try:
                from conversation_registry import record as _record_conv
                _record_conv(
                    getattr(chatbot_msg, "conversation_id", None),
                    getattr(chatbot_msg, "conversation_title", None),
                    str(getattr(chatbot_msg, "conversation_type", "") or ""),
                    getattr(chatbot_msg, "robot_code", None),
                )
            except Exception:  # noqa: BLE001
                logger.exception("failed to record conversation")
```

Do not touch any other line.

---

## Rules

- Verbatim copy.
- Don't touch any file not listed above.

## Report

1. `wc -l conversation_registry.py`
2. `python3 -c "import conversation_registry as cr; cr.record('test-conv-id-1', '测试群', '2', 'rc'); print(cr.lookup('测试群'))"` (should print dict with id/type/last_seen, registry file gets created at ~/.paperclip/dingtalk_conversations.json — that's expected)
3. `grep -n "conversation_registry\|record_conv" main.py`
4. Deviations (should be none).
