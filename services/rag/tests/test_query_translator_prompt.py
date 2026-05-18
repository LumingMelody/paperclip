"""Live-LM-Studio regression for the translation prompt.

Reuses the existing 'integration' pytest marker — skipped in CI; run locally
with `uv run pytest -m integration tests/test_query_translator_prompt.py`.

The 10 canon queries are kept BYTE-FOR-BYTE in sync with the QUERIES list in
scripts/eval_search.py — they are the Phase 2a fixed eval rubric. Any prompt
regression here will surface during eval before it surfaces in production.
"""
from __future__ import annotations

import pytest

from paperclip_rag.config import get_settings
from paperclip_rag.lm_studio import LMStudioClient
from paperclip_rag.query_translator import translate_if_cjk


# Keep this list in sync with scripts/eval_search.py::QUERIES.
# Each tuple: (Chinese query exactly as eval runs it, list of lower-cased
# substrings the English translation must contain).
CANON_QUERIES: list[tuple[str, list[str]]] = [
    ("偏小 升一码",          ["small", "size"]),
    ("偏大 降一码",          ["large", "size"]),
    ("物流损坏 包装",        ["damage", "packag"]),
    ("做工 缝线 质量",       ["workmanship", "quality"]),
    ("颜色差 色差",          ["color"]),
    ("不符合描述 与图片不符", ["description"]),
    ("EG02084",             ["EG02084"]),          # pure-English passthrough
    ("Amazon 退货",          ["Amazon", "return"]),
    ("没收到 物流丢失",       ["receive", "lost"]),
    ("异味 味道大",          ["smell", "odor"]),
]


@pytest.fixture(scope="function")
def lm_client():
    s = get_settings()
    return LMStudioClient(
        base_url=s.lm_studio_base_url,
        llm_model=s.llm_model,
        embedding_model=s.embedding_model,
    )


@pytest.mark.integration
@pytest.mark.parametrize("query, expected_substrings", CANON_QUERIES)
@pytest.mark.asyncio
async def test_canon_query_translation_contains_keywords(
    lm_client, query, expected_substrings
):
    result = await translate_if_cjk(query, lm_client=lm_client)
    # EG02084 is pure-English, so it goes through passthrough; everything else
    # should hit the translated branch.
    if not any(0x4E00 <= ord(c) <= 0x9FFF for c in query):
        assert result.status == "passthrough", (
            f"expected passthrough for non-CJK query, got {result.status}"
        )
    else:
        assert result.status == "translated", (
            f"expected translation, got {result.status} "
            f"(reason={result.fallback_reason}, text={result.text!r})"
        )
    lowered = result.text.lower()
    for needle in expected_substrings:
        assert needle.lower() in lowered, (
            f"query={query!r} expected substring {needle!r} in {result.text!r}"
        )
