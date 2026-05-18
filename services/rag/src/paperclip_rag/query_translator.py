"""CN→EN query translation layer for /search.

Soft, best-effort. Any failure falls back to the original query.
"""
from __future__ import annotations

import re

_CJK_RE = re.compile(r"[一-鿿]")


def contains_cjk(text: str) -> bool:
    """Return True if `text` contains any CJK Unified Ideograph (U+4E00..U+9FFF)."""
    return bool(_CJK_RE.search(text))
