"""CN→EN query translation layer for /search.

Soft, best-effort. Any failure falls back to the original query.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from .lm_studio import LMStudioClient

_CJK_RE = re.compile(r"[一-鿿]")


def contains_cjk(text: str) -> bool:
    """Return True if `text` contains any CJK Unified Ideograph (U+4E00..U+9FFF)."""
    return bool(_CJK_RE.search(text))


TranslationStatus = Literal["passthrough", "translated", "fallback"]


@dataclass(frozen=True)
class TranslationResult:
    text: str
    original: str
    status: TranslationStatus
    detect_ms: int
    translate_ms: int
    fallback_reason: str | None = None


async def translate_if_cjk(
    query: str,
    lm_client: "LMStudioClient",
    *,
    llm_model: str | None = None,
    timeout_s: float = 5.0,
) -> TranslationResult:
    t0 = time.perf_counter()
    has_cjk = contains_cjk(query)
    detect_ms = int((time.perf_counter() - t0) * 1000)

    if not has_cjk:
        return TranslationResult(
            text=query,
            original=query,
            status="passthrough",
            detect_ms=detect_ms,
            translate_ms=0,
        )

    # Translation paths added in later tasks.
    raise NotImplementedError("translation path implemented in Task 6")
