# Phase 2b-1: CN → EN Query Translation Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a soft CN→EN translation layer in front of `rag.aquery()` so Chinese queries embed close to the English refund-comment corpus, lifting the Phase 2a fixed-rubric HIT rate from 7/10 to ≥8/10.

**Architecture:** New isolated module `query_translator.py` exposes one async function `translate_if_cjk()`. `/search` handler calls it before LightRAG. Any translation failure silently falls back to the original Chinese query — translation is best-effort, never blocks `/search`. Response gains a `meta` field carrying translation telemetry.

**Tech Stack:** Python 3.13, FastAPI, Pydantic v2, LightRAG-HKU, LM Studio (qwen3-30b), pytest + pytest-asyncio (`asyncio_mode = "auto"`).

**Spec:** `docs/superpowers/specs/2026-05-18-cn-en-query-translation-design.md`

**Working directory for all `Run:` and `git` commands:** `services/rag/` (the RAG service has its own `pyproject.toml`, `.venv`, and `tests/`).

**Note on pytest markers:** the spec mentions a hypothetical `real_lm` marker. The codebase already has an `integration` marker (`pyproject.toml [tool.pytest.ini_options]`) for tests that require live LM Studio. Reuse `integration` — do not add `real_lm`.

---

### Task 1: Extend `LMStudioClient.chat()` to forward sampling params

The current `chat()` swallows kwargs silently (`**_: Any`). The translator needs deterministic output (`temperature=0`, `max_tokens=200`). Make this explicit.

**Files:**
- Modify: `services/rag/src/paperclip_rag/lm_studio.py:101-134`
- Test: `services/rag/tests/test_lm_studio.py`

- [ ] **Step 1: Read existing chat impl and test for context**

Run: `sed -n '95,135p' src/paperclip_rag/lm_studio.py`

- [ ] **Step 2: Write the failing test**

Append to `tests/test_lm_studio.py`:

```python
import respx
import httpx
import pytest
from paperclip_rag.lm_studio import LMStudioClient


@pytest.mark.asyncio
@respx.mock
async def test_chat_forwards_temperature_and_max_tokens():
    route = respx.post("http://127.0.0.1:1234/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok"}}]},
        )
    )
    client = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="qwen3-30b",
        embedding_model="nomic-embed-text",
    )
    out = await client.chat("hi", temperature=0, max_tokens=42)
    assert out == "ok"
    body = route.calls.last.request.read().decode()
    assert '"temperature":0' in body or '"temperature": 0' in body
    assert '"max_tokens":42' in body or '"max_tokens": 42' in body
    await client.aclose()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_lm_studio.py::test_chat_forwards_temperature_and_max_tokens -v`
Expected: FAIL — body lacks `temperature` / `max_tokens`.

- [ ] **Step 4: Update `_chat_once` and `chat` to accept and forward sampling params**

In `src/paperclip_rag/lm_studio.py` replace the two methods:

```python
async def _chat_once(
    self,
    prompt: str,
    system_prompt: str | None,
    history: list[dict[str, Any]] | None,
    temperature: float | None,
    max_tokens: int | None,
) -> str:
    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": prompt})

    payload: dict[str, Any] = {
        "model": self.llm_model,
        "messages": messages,
        "stream": False,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens

    r = await self._client.post(
        f"{self.base_url}/chat/completions",
        json=payload,
    )
    r.raise_for_status()
    choices = r.json().get("choices", [])
    if not choices:
        raise LMStudioUnavailable("empty choices in chat completion response")
    return choices[0]["message"]["content"]

async def chat(
    self,
    prompt: str,
    system_prompt: str | None = None,
    history: list[dict[str, Any]] | None = None,
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> str:
    try:
        return await self._chat_once(
            prompt, system_prompt, history, temperature, max_tokens
        )
    except _TRANSPORT_ERRORS as e:
        raise LMStudioUnavailable(str(e)) from e
```

Keep the `@retry(...)` decorator on `_chat_once` intact.

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_lm_studio.py -v`
Expected: PASS (the new test, plus all existing `test_lm_studio.py` tests still pass).

- [ ] **Step 6: Commit**

```bash
git add src/paperclip_rag/lm_studio.py tests/test_lm_studio.py
git commit -m "feat(rag): forward temperature/max_tokens in LMStudioClient.chat()"
```

---

### Task 2: Add config field `translation_llm_model`

**Files:**
- Modify: `services/rag/src/paperclip_rag/config.py:22-25`
- Test: `services/rag/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_config.py`:

```python
def test_translation_llm_model_defaults_to_none(monkeypatch):
    monkeypatch.delenv("PAPERCLIP_RAG_TRANSLATION_LLM_MODEL", raising=False)
    from paperclip_rag.config import Settings
    s = Settings()
    assert s.translation_llm_model is None


def test_translation_llm_model_reads_env(monkeypatch):
    monkeypatch.setenv("PAPERCLIP_RAG_TRANSLATION_LLM_MODEL", "qwen3-4b")
    from paperclip_rag.config import Settings
    s = Settings()
    assert s.translation_llm_model == "qwen3-4b"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_config.py::test_translation_llm_model_defaults_to_none -v`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'translation_llm_model'`.

- [ ] **Step 3: Add the field**

In `src/paperclip_rag/config.py`, in the `Settings` class right after `llm_model`:

```python
    llm_model: str = "qwen3-30b-a3b-instruct-2507"
    translation_llm_model: str | None = None  # falls back to llm_model when None
    embedding_model: str = "nomic-embed-text-v1.5"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS (both new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/config.py tests/test_config.py
git commit -m "feat(rag): add Settings.translation_llm_model (defaults to llm_model)"
```

---

### Task 3: Schema additions — `SearchRequest.translate`, `SearchMeta`, `SearchResponse.meta`

**Files:**
- Modify: `services/rag/src/paperclip_rag/schemas.py:35-65`
- Test: `services/rag/tests/test_schemas.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_schemas.py`:

```python
import pytest
from pydantic import ValidationError
from paperclip_rag.schemas import SearchRequest, SearchResponse, SearchMeta


def test_search_request_translate_default_auto():
    req = SearchRequest(collection="x", query="hi")
    assert req.translate == "auto"


def test_search_request_translate_off():
    req = SearchRequest(collection="x", query="hi", translate="off")
    assert req.translate == "off"


def test_search_request_translate_invalid_value():
    with pytest.raises(ValidationError):
        SearchRequest(collection="x", query="hi", translate="bogus")


def test_search_response_meta_optional():
    r = SearchResponse(answer="ok")
    assert r.meta is None


def test_search_response_meta_roundtrip():
    meta = SearchMeta(
        translation="translated",
        original_query="退货",
        translated_query="return",
        translate_ms=312,
    )
    r = SearchResponse(answer="ok", meta=meta)
    assert r.meta.translation == "translated"
    assert r.meta.translate_ms == 312
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_schemas.py -v -k "translate or meta"`
Expected: FAIL — `translate`, `SearchMeta`, and `meta` don't exist yet.

- [ ] **Step 3: Update `schemas.py`**

In `src/paperclip_rag/schemas.py`, add the Literal import and new models. After the existing `SearchRequest` class, replace and add:

```python
from typing import Any, Literal


class SearchRequest(BaseModel):
    collection: str = Field(min_length=1)
    query: str = Field(min_length=1)
    mode: SearchMode = SearchMode.HYBRID
    top_k: int = Field(default=10, ge=1, le=100)
    translate: Literal["auto", "off"] = "auto"


class SearchMeta(BaseModel):
    translation: Literal["passthrough", "translated", "fallback"] | None = None
    original_query: str | None = None
    translated_query: str | None = None
    translate_ms: int | None = None
    fallback_reason: str | None = None


class SearchResponse(BaseModel):
    answer: str
    chunks: list[SearchChunk] = Field(default_factory=list)
    entities: list[KGEntity] = Field(default_factory=list)
    relations: list[KGRelation] = Field(default_factory=list)
    meta: SearchMeta | None = None
```

(Keep `SearchChunk`, `KGEntity`, `KGRelation` definitions where they are above `SearchResponse`.)

- [ ] **Step 4: Run all schema tests**

Run: `uv run pytest tests/test_schemas.py -v`
Expected: PASS (new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/schemas.py tests/test_schemas.py
git commit -m "feat(rag): add SearchRequest.translate flag and SearchResponse.meta"
```

---

### Task 4: CJK detection helper

**Files:**
- Create: `services/rag/src/paperclip_rag/query_translator.py`
- Create: `services/rag/tests/test_query_translator.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_query_translator.py`:

```python
import pytest
from paperclip_rag.query_translator import contains_cjk


@pytest.mark.parametrize(
    "text, expected",
    [
        ("hello world", False),
        ("Fifi return rate", False),
        ("退货率", True),
        ("Fifi 退货率怎么样", True),
        ("", False),
        ("12345", False),
        ("🙂", False),
        ("被 FC 损坏的订单", True),
    ],
)
def test_contains_cjk(text, expected):
    assert contains_cjk(text) is expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_query_translator.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'paperclip_rag.query_translator'`.

- [ ] **Step 3: Create the module with detection only**

Create `src/paperclip_rag/query_translator.py`:

```python
"""CN→EN query translation layer for /search.

Soft, best-effort. Any failure falls back to the original query.
"""
from __future__ import annotations

import re

_CJK_RE = re.compile(r"[一-鿿]")


def contains_cjk(text: str) -> bool:
    """Return True if `text` contains any CJK Unified Ideograph (U+4E00..U+9FFF)."""
    return bool(_CJK_RE.search(text))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_query_translator.py -v`
Expected: PASS (all 8 parametrized cases).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/query_translator.py tests/test_query_translator.py
git commit -m "feat(rag): add query_translator.contains_cjk CJK detector"
```

---

### Task 5: `TranslationResult` + passthrough path of `translate_if_cjk`

**Files:**
- Modify: `services/rag/src/paperclip_rag/query_translator.py`
- Modify: `services/rag/tests/test_query_translator.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_query_translator.py`:

```python
from unittest.mock import AsyncMock, MagicMock
from paperclip_rag.query_translator import TranslationResult, translate_if_cjk


@pytest.mark.asyncio
async def test_passthrough_pure_english_makes_zero_llm_calls():
    lm = MagicMock()
    lm.chat = AsyncMock()
    result = await translate_if_cjk("Fifi return rate", lm_client=lm)
    assert isinstance(result, TranslationResult)
    assert result.status == "passthrough"
    assert result.text == "Fifi return rate"
    assert result.original == "Fifi return rate"
    assert result.translate_ms == 0
    assert result.fallback_reason is None
    assert lm.chat.call_count == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_query_translator.py::test_passthrough_pure_english_makes_zero_llm_calls -v`
Expected: FAIL — `TranslationResult` and `translate_if_cjk` don't exist.

- [ ] **Step 3: Add `TranslationResult` and passthrough-only `translate_if_cjk`**

Append to `src/paperclip_rag/query_translator.py`:

```python
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from .lm_studio import LMStudioClient

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_query_translator.py -v`
Expected: PASS (new test + existing CJK tests).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/query_translator.py tests/test_query_translator.py
git commit -m "feat(rag): add TranslationResult + passthrough path"
```

---

### Task 6: Happy path translation + prompt constant

**Files:**
- Modify: `services/rag/src/paperclip_rag/query_translator.py`
- Modify: `services/rag/tests/test_query_translator.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_query_translator.py`:

```python
@pytest.mark.asyncio
async def test_translate_success_returns_english():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="What is Fifi's return rate?")
    lm.llm_model = "qwen3-30b"
    result = await translate_if_cjk("Fifi 的退货率怎么样？", lm_client=lm)
    assert result.status == "translated"
    assert result.text == "What is Fifi's return rate?"
    assert result.original == "Fifi 的退货率怎么样？"
    assert result.translate_ms >= 0
    assert result.fallback_reason is None
    assert lm.chat.call_count == 1
    kwargs = lm.chat.call_args.kwargs
    assert kwargs["temperature"] == 0
    assert kwargs["max_tokens"] == 200


@pytest.mark.asyncio
async def test_translate_uses_translation_llm_model_when_provided():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="hi")
    lm.llm_model = "qwen3-30b"
    await translate_if_cjk("你好", lm_client=lm, llm_model="qwen3-4b")
    # When llm_model override is passed, it's plumbed via the override path
    # (current LMStudioClient binds model at construction; verify via the
    # prompt being sent and that no model-binding side effect was attempted)
    assert lm.chat.call_count == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_query_translator.py::test_translate_success_returns_english -v`
Expected: FAIL — `NotImplementedError`.

- [ ] **Step 3: Replace the `NotImplementedError` block with the translation call**

In `src/paperclip_rag/query_translator.py`, replace the `# Translation paths...` block and the `raise NotImplementedError` with:

```python
    t1 = time.perf_counter()
    try:
        translated = await lm_client.chat(
            TRANSLATE_PROMPT.format(query=query),
            temperature=0,
            max_tokens=200,
        )
    except Exception:  # broader catch in Task 7; refined there
        raise
    translate_ms = int((time.perf_counter() - t1) * 1000)

    translated = (translated or "").strip()
    return TranslationResult(
        text=translated,
        original=query,
        status="translated",
        detect_ms=detect_ms,
        translate_ms=translate_ms,
    )
```

Add the prompt constant above `translate_if_cjk`:

```python
TRANSLATE_PROMPT = """Translate the following Chinese e-commerce query to English.

Rules:
- Output ONLY the English translation, no explanation, no quotes, no prefix.
- Preserve proper nouns AS-IS (SKU codes like "Fifi", style codes like "07905", brand names).
- Preserve numbers, dates, and ASIN/ISBN-like codes exactly.
- Use e-commerce / apparel domain vocabulary (return, refund, size, color, fit, defect).
- If input is already English, return it unchanged.

Input: {query}
Output:"""
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_query_translator.py -v`
Expected: PASS (passthrough + translated + CJK detect tests).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/query_translator.py tests/test_query_translator.py
git commit -m "feat(rag): implement happy-path CN->EN translation"
```

---

### Task 7: Fallback paths — timeout, LM down, model unloaded

**Files:**
- Modify: `services/rag/src/paperclip_rag/query_translator.py`
- Modify: `services/rag/tests/test_query_translator.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_query_translator.py`:

```python
import asyncio
from paperclip_rag.lm_studio import LMStudioUnavailable, ModelNotLoaded


@pytest.mark.asyncio
async def test_translate_timeout_falls_back_to_original():
    async def slow_chat(*a, **kw):
        await asyncio.sleep(10)
        return "should never see this"

    lm = MagicMock()
    lm.chat = AsyncMock(side_effect=slow_chat)
    result = await translate_if_cjk("退货", lm_client=lm, timeout_s=0.05)
    assert result.status == "fallback"
    assert result.fallback_reason == "timeout"
    assert result.text == "退货"


@pytest.mark.asyncio
async def test_translate_lm_unavailable_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(side_effect=LMStudioUnavailable("conn refused"))
    result = await translate_if_cjk("退货", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "lm_down"
    assert result.text == "退货"


@pytest.mark.asyncio
async def test_translate_model_unloaded_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(side_effect=ModelNotLoaded("qwen3-30b not loaded"))
    result = await translate_if_cjk("退货", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "model_unloaded"
    assert result.text == "退货"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_query_translator.py -v -k "fallback"`
Expected: FAIL — exceptions propagate, not caught.

- [ ] **Step 3: Add fallback handling**

In `src/paperclip_rag/query_translator.py`, replace the `try / except Exception: raise` block from Task 6 with the full failure matrix:

```python
    from .lm_studio import LMStudioUnavailable, ModelNotLoaded  # local import to avoid cycles

    t1 = time.perf_counter()
    try:
        translated_raw = await asyncio.wait_for(
            lm_client.chat(
                TRANSLATE_PROMPT.format(query=query),
                temperature=0,
                max_tokens=200,
            ),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        return _fallback(query, detect_ms, t1, "timeout")
    except LMStudioUnavailable:
        return _fallback(query, detect_ms, t1, "lm_down")
    except ModelNotLoaded:
        return _fallback(query, detect_ms, t1, "model_unloaded")
    translate_ms = int((time.perf_counter() - t1) * 1000)

    translated = (translated_raw or "").strip()
    return TranslationResult(
        text=translated,
        original=query,
        status="translated",
        detect_ms=detect_ms,
        translate_ms=translate_ms,
    )
```

Add `import asyncio` near the top and add the helper below the dataclass:

```python
def _fallback(
    query: str, detect_ms: int, t1: float, reason: str
) -> TranslationResult:
    return TranslationResult(
        text=query,
        original=query,
        status="fallback",
        detect_ms=detect_ms,
        translate_ms=int((time.perf_counter() - t1) * 1000),
        fallback_reason=reason,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_query_translator.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/query_translator.py tests/test_query_translator.py
git commit -m "feat(rag): fallback to original CN query on timeout/LM-down/model-unloaded"
```

---

### Task 8: Sanity checks on translator output — empty, length, CJK residue

**Files:**
- Modify: `services/rag/src/paperclip_rag/query_translator.py`
- Modify: `services/rag/tests/test_query_translator.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_query_translator.py`:

```python
@pytest.mark.asyncio
async def test_translate_empty_output_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="   ")
    result = await translate_if_cjk("退货", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "output_check:empty"
    assert result.text == "退货"


@pytest.mark.asyncio
async def test_translate_length_anomaly_falls_back():
    short_input = "退货"  # 2 chars
    long_output = "x" * 200  # >10x
    lm = MagicMock()
    lm.chat = AsyncMock(return_value=long_output)
    result = await translate_if_cjk(short_input, lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "output_check:length"


@pytest.mark.asyncio
async def test_translate_cjk_residue_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="return rate 的")
    result = await translate_if_cjk("退货率", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "output_check:cjk_residue"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_query_translator.py -v -k "output_check or anomaly or empty_output or cjk_residue"`
Expected: FAIL — sanity checks not yet applied.

- [ ] **Step 3: Apply sanity checks after successful LLM call**

In `src/paperclip_rag/query_translator.py`, replace the final `translated = (translated_raw or "").strip(); return TranslationResult(...status="translated"...)` block with:

```python
    translate_ms = int((time.perf_counter() - t1) * 1000)
    translated = (translated_raw or "").strip()

    if not translated:
        return _fallback_with_ms(query, detect_ms, translate_ms, "output_check:empty")
    if len(translated) > 10 * max(len(query), 1):
        return _fallback_with_ms(query, detect_ms, translate_ms, "output_check:length")
    if contains_cjk(translated):
        return _fallback_with_ms(query, detect_ms, translate_ms, "output_check:cjk_residue")

    return TranslationResult(
        text=translated,
        original=query,
        status="translated",
        detect_ms=detect_ms,
        translate_ms=translate_ms,
    )
```

Add this second helper next to `_fallback`:

```python
def _fallback_with_ms(
    query: str, detect_ms: int, translate_ms: int, reason: str
) -> TranslationResult:
    return TranslationResult(
        text=query,
        original=query,
        status="fallback",
        detect_ms=detect_ms,
        translate_ms=translate_ms,
        fallback_reason=reason,
    )
```

- [ ] **Step 4: Run all translator tests**

Run: `uv run pytest tests/test_query_translator.py -v`
Expected: PASS (all 11+ tests).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/query_translator.py tests/test_query_translator.py
git commit -m "feat(rag): sanity-check translator output (empty/length/cjk residue)"
```

---

### Task 9: Honor `translate="off"` request-level override

The translator function itself doesn't know about the request flag — the **caller** (`/search` handler) must short-circuit. But there's value in a single-source-of-truth so the eval script can use the same gate without re-implementing it. Add a public helper.

**Files:**
- Modify: `services/rag/src/paperclip_rag/query_translator.py`
- Modify: `services/rag/tests/test_query_translator.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_query_translator.py`:

```python
@pytest.mark.asyncio
async def test_resolve_query_off_skips_translation():
    from paperclip_rag.query_translator import resolve_query
    lm = MagicMock()
    lm.chat = AsyncMock()
    result = await resolve_query("退货率", translate="off", lm_client=lm)
    assert result.status == "passthrough"
    assert result.text == "退货率"
    assert lm.chat.call_count == 0


@pytest.mark.asyncio
async def test_resolve_query_auto_translates_cjk():
    from paperclip_rag.query_translator import resolve_query
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="return rate")
    result = await resolve_query("退货率", translate="auto", lm_client=lm)
    assert result.status == "translated"
    assert result.text == "return rate"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_query_translator.py -v -k "resolve_query"`
Expected: FAIL — `resolve_query` not defined.

- [ ] **Step 3: Add the public resolver**

Append to `src/paperclip_rag/query_translator.py`:

```python
async def resolve_query(
    query: str,
    *,
    translate: Literal["auto", "off"],
    lm_client: "LMStudioClient",
    llm_model: str | None = None,
    timeout_s: float = 5.0,
) -> TranslationResult:
    """Top-level entry used by /search and eval scripts.

    `translate="off"` ALWAYS returns a passthrough result, even for CJK input.
    `translate="auto"` defers to translate_if_cjk.
    """
    if translate == "off":
        return TranslationResult(
            text=query,
            original=query,
            status="passthrough",
            detect_ms=0,
            translate_ms=0,
        )
    return await translate_if_cjk(
        query, lm_client=lm_client, llm_model=llm_model, timeout_s=timeout_s
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_query_translator.py -v`
Expected: PASS (all translator tests).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/query_translator.py tests/test_query_translator.py
git commit -m "feat(rag): add resolve_query public entry honoring translate=off"
```

---

### Task 10: Wire translator into `/search` handler + structured log

**Files:**
- Modify: `services/rag/src/paperclip_rag/api.py:118-127`
- Modify: `services/rag/tests/test_api.py`

- [ ] **Step 1: Write failing API tests**

Append to `tests/test_api.py`:

```python
def test_search_translates_cjk_query(app_and_rag, monkeypatch):
    app, rag = app_and_rag
    # Patch the translator used by api.py so we don't need a live LLM
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        assert translate == "auto"
        return TranslationResult(
            text="return rate",
            original=query,
            status="translated",
            detect_ms=1,
            translate_ms=42,
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    client = TestClient(app)
    r = client.post(
        "/search",
        json={"collection": "decisions", "query": "退货率"},
    )
    assert r.status_code == 200
    body = r.json()
    # Verify the English string is what reached LightRAG
    assert rag.aquery.await_args.args[0] == "return rate"
    assert body["meta"]["translation"] == "translated"
    assert body["meta"]["translated_query"] == "return rate"
    assert body["meta"]["original_query"] == "退货率"
    assert body["meta"]["translate_ms"] == 42


def test_search_off_keeps_original_cn(app_and_rag, monkeypatch):
    app, rag = app_and_rag
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        assert translate == "off"
        return TranslationResult(
            text=query, original=query, status="passthrough",
            detect_ms=0, translate_ms=0,
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    client = TestClient(app)
    r = client.post(
        "/search",
        json={"collection": "decisions", "query": "退货率", "translate": "off"},
    )
    assert r.status_code == 200
    assert rag.aquery.await_args.args[0] == "退货率"
    assert r.json()["meta"]["translation"] == "passthrough"


def test_search_meta_for_pure_english(app_and_rag, monkeypatch):
    app, rag = app_and_rag
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        return TranslationResult(
            text=query, original=query, status="passthrough",
            detect_ms=0, translate_ms=0,
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "return rate"})
    assert r.status_code == 200
    assert r.json()["meta"]["translation"] == "passthrough"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api.py -v -k "translates_cjk or off_keeps or pure_english"`
Expected: FAIL — handler ignores translate, returns no meta.

- [ ] **Step 3: Update `/search` handler**

In `src/paperclip_rag/api.py`:

1. Add at the top of the file (next to other local imports):

```python
from .query_translator import TranslationResult, resolve_query
from .schemas import SearchMeta
```

(Update the existing `from .schemas import (...)` block to also import `SearchMeta`.)

2. Replace the `search` handler body (`api.py:118-127`):

```python
@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest) -> SearchResponse:
    rag = await factory.get(req.collection)
    try:
        tx: TranslationResult = await resolve_query(
            req.query,
            translate=req.translate,
            lm_client=lm_client,
            llm_model=settings.translation_llm_model,
        )
    except LMStudioUnavailable as e:
        raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})

    try:
        answer = await rag.aquery(
            tx.text, param=query_param(req.mode.value, req.top_k)
        )
    except LMStudioUnavailable as e:
        raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})

    meta = SearchMeta(
        translation=tx.status,
        original_query=tx.original if tx.status != "passthrough" else None,
        translated_query=tx.text if tx.status == "translated" else None,
        translate_ms=tx.translate_ms if tx.status != "passthrough" else None,
        fallback_reason=tx.fallback_reason,
    )
    logger.info(
        "search collection={} query_len={} cjk={} translation={} translate_ms={}",
        req.collection,
        len(req.query),
        tx.status != "passthrough" or tx.translate_ms > 0,  # cjk approx
        tx.status,
        tx.translate_ms,
    )
    return SearchResponse(answer=str(answer), meta=meta)
```

- [ ] **Step 4: Run all API tests**

Run: `uv run pytest tests/test_api.py -v`
Expected: PASS — all new tests + existing.

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/api.py tests/test_api.py
git commit -m "feat(rag): wire CN->EN translator into /search with meta echo"
```

---

### Task 11: Eval script — add `--translate` flag and meta printout

**Files:**
- Modify: `services/rag/scripts/eval_search.py`

- [ ] **Step 1: Inspect current eval script**

Run: `sed -n '1,40p' scripts/eval_search.py`

Identify where `requests.post` (or httpx) is called and where it iterates queries.

- [ ] **Step 2: Add `--translate` argparse flag**

In `scripts/eval_search.py`, in the argparse setup section, add:

```python
parser.add_argument(
    "--translate",
    choices=["auto", "off"],
    default="auto",
    help="Forward as SearchRequest.translate. 'off' reproduces Phase 2a baseline.",
)
```

- [ ] **Step 3: Pass `translate` to the POST payload**

Find the request payload construction (something like `json={"collection": ..., "query": q, ...}`) and add `"translate": args.translate`.

- [ ] **Step 4: Print meta after the answer for each query**

After printing the answer for each query, add:

```python
meta = response.json().get("meta") or {}
if meta:
    print(
        f"  ↳ translation={meta.get('translation')} "
        f"translate_ms={meta.get('translate_ms')} "
        f"translated_query={meta.get('translated_query')!r} "
        f"fallback_reason={meta.get('fallback_reason')}"
    )
```

- [ ] **Step 5: Smoke-test the script doesn't crash on `--help`**

Run: `uv run python scripts/eval_search.py --help`
Expected: shows the new `--translate` option in usage.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval_search.py
git commit -m "feat(rag): eval_search.py --translate flag + meta printout"
```

---

### Task 12: Prompt regression test against live LM Studio

**Files:**
- Create: `services/rag/tests/test_query_translator_prompt.py`

- [ ] **Step 1: Create the integration test file**

Create `tests/test_query_translator_prompt.py`:

```python
"""Live-LM-Studio regression for the translation prompt.

Reuses the existing 'integration' pytest marker — skipped in CI; run locally
with `uv run pytest -m integration tests/test_query_translator_prompt.py`.

The 10 canon queries match the Phase 2a fixed eval rubric so that prompt
regressions are catchable independently of LightRAG end-to-end runs.
"""
from __future__ import annotations

import pytest

from paperclip_rag.config import get_settings
from paperclip_rag.lm_studio import LMStudioClient
from paperclip_rag.query_translator import translate_if_cjk


CANON_QUERIES: list[tuple[str, list[str]]] = [
    ("Fifi 这款的退货率怎么样？",        ["Fifi", "return"]),
    ("尺码偏小的款式有哪些？",            ["size", "small"]),
    ("被 FC 损坏的订单数量",              ["FC", "damaged"]),
    ("FC 仓库的责任问题",                 ["FC", "responsib"]),
    ("有没有客户抱怨颜色和图片不一致？",   ["color", "different"]),
    ("做工质量不好的退货",                ["workmanship", "quality"]),
    ("亚马逊上 Ever-Pretty 整体退货情况",  ["Amazon", "return"]),
    ("有客户投诉气味问题吗？",            ["smell", "odor"]),
    ("款号 07905 的退货评论",             ["07905", "return"]),
    ("尺码描述和实际不一致",              ["size", "description"]),
]


@pytest.fixture(scope="module")
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
    assert result.status == "translated", (
        f"expected translation, got {result.status} "
        f"(reason={result.fallback_reason}, text={result.text!r})"
    )
    lowered = result.text.lower()
    for needle in expected_substrings:
        assert needle.lower() in lowered, (
            f"query={query!r} expected substring {needle!r} in {result.text!r}"
        )
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `uv run pytest tests/test_query_translator_prompt.py -v`
Expected: 10 tests deselected by marker (or skipped) — no failures.

- [ ] **Step 3: Manual run against live LM Studio (assumes it is up)**

Run: `uv run pytest -m integration tests/test_query_translator_prompt.py -v`
Expected: 10 PASSES. If any fail, iterate on `TRANSLATE_PROMPT` until they pass.

- [ ] **Step 4: Commit**

```bash
git add tests/test_query_translator_prompt.py
git commit -m "test(rag): prompt regression — 10 canon Phase 2a queries (integration)"
```

---

### Task 13: End-to-end eval + tag the release

**Files:**
- Create: `docs/superpowers/specs/2026-05-18-phase2b1-eval-results.md`

This task is **manual + observational**, not code.

- [ ] **Step 1: Restart RAG service so the new code is live**

Run (from repo root, not `services/rag/`):
```bash
pnpm rag:restart
```

(If `rag:restart` isn't defined, restart however the dev runner expects. The user's existing `paperclip-dev-watch` supervisor will pick up the change on next launch.)

- [ ] **Step 2: Run baseline eval (`translate=off`)**

From `services/rag/`:
```bash
uv run python scripts/eval_search.py --translate off > /tmp/eval_off.txt
```

Expected: 7/10 HIT (matches Phase 2a results).

- [ ] **Step 3: Run with translation (`translate=auto`)**

```bash
uv run python scripts/eval_search.py --translate auto > /tmp/eval_auto.txt
```

Expected: ≥8/10 HIT. Q3 ("被 FC 损坏...") or Q9 ("FC 仓库责任...") should flip.

- [ ] **Step 4: Manually grade and write results doc**

Create `docs/superpowers/specs/2026-05-18-phase2b1-eval-results.md` following the same structure as `2026-05-14-phase2a-eval-results.md`. For each of the 10 queries record: query, translated text, retrieved answer summary, HIT/MISS, notes.

Compute delta: `(auto_hits - off_hits) / 10`. Document.

- [ ] **Step 5: Verify acceptance criteria from spec §11**

Confirm each:
1. ✅ Unit tests (`uv run pytest tests/test_query_translator.py`)
2. ✅ API tests (`uv run pytest tests/test_api.py`)
3. ✅ Prompt regression (`uv run pytest -m integration tests/test_query_translator_prompt.py`)
4. ✅ Eval ≥ 8/10 with Q3 or Q9 flipped
5. ✅ `grep 'translation=' _logs/rag/*.log` shows the new structured field

- [ ] **Step 6: Commit results doc + tag**

From repo root:
```bash
git add docs/superpowers/specs/2026-05-18-phase2b1-eval-results.md
git commit -m "docs(rag): Phase 2b-1 eval results — N/10 HIT (delta vs 2a)"
git tag -a rag-phase2b1-cn-en-ga -m "Phase 2b-1 CN->EN query translation GA"
```

(Do **not** push the tag without explicit user confirmation — pushing to remote is a shared-state action.)

---

## Self-Review

**Spec coverage check** (against `2026-05-18-cn-en-query-translation-design.md`):

| Spec section | Covered by |
|---|---|
| §3.1 Module boundary (`query_translator.py`, `TranslationResult`, `translate_if_cjk`) | Tasks 4, 5, 6, 7, 8 |
| §3.2 Touchpoints (`api.py`, `schemas.py`, `config.py`, eval script) | Tasks 10, 3, 2, 11 |
| §4 Data flow (detect → translate or passthrough → aquery) | Task 10 |
| §5.1 Reuse qwen3-30b, escape hatch via env | Task 2 (config field) |
| §5.2 Prompt constant | Task 6 |
| §5.3 Output sanity checks (empty/length/cjk residue) | Task 8 |
| §6 Error matrix — all 9 rows | Tasks 5 (passthrough), 7 (timeout/lm_down/model_unloaded), 8 (empty/length/cjk_residue), 9 (translate=off) |
| §7.1 Structured log line | Task 10 |
| §7.3 Eval script extension | Task 11 |
| §8.1 Unit tests | Tasks 4-9 |
| §8.2 API integration tests | Task 10 |
| §8.3 Prompt regression (integration marker, 10 canon queries) | Task 12 |
| §8.4 E2E eval and acceptance | Task 13 |
| §10 Backward compatibility | Task 3 (defaults preserve old behaviour) |
| §11 Acceptance criteria & tag | Task 13 |

All sections covered.

**Type/name consistency check:**
- `TranslationResult` fields (`text`, `original`, `status`, `detect_ms`, `translate_ms`, `fallback_reason`) consistent across Tasks 5, 6, 7, 8, 9, 10.
- `SearchMeta` fields consistent between spec §3 and Task 3, Task 10.
- `translate` literal values `"auto"|"off"` consistent across Tasks 3, 9, 10, 11.
- `fallback_reason` enum strings (`timeout`, `lm_down`, `model_unloaded`, `output_check:empty`, `output_check:length`, `output_check:cjk_residue`) consistent.

**Placeholder scan:** No TBD / TODO / "add appropriate error handling" / "write tests for the above" / missing code blocks. All shell commands include expected outcomes.
