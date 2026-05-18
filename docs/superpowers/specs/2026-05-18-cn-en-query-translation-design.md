# Phase 2b-1: CN → EN Query Translation Layer — Design

**Status:** Draft for review
**Date:** 2026-05-18
**Owner:** Paperclip RAG team
**Supersedes parts of:** `2026-05-13-paperclip-rag-design.md` (the `/search` request flow)

---

## 1. Context & Motivation

Phase 2a evaluation ([2026-05-14-phase2a-eval-results.md](2026-05-14-phase2a-eval-results.md))
shipped at **7/10 HIT** against the fixed 10-query rubric. Two of the three
misses (Q3 "被 FC 损坏的订单数量", Q9 "FC 仓库责任") are **not** data gaps —
the `DAMAGED_BY_FC` entity and related relations exist in the knowledge graph.
They fail because:

- Customer comments in `refund_comments` are 99% English.
- Embeddings are produced by `nomic-embed-text-v1.5` (English-centric).
- Chinese queries land far in vector space from semantically equivalent
  English chunks, even after LightRAG's KG-augmented retrieval.

Fixing this lifts the eval ceiling from 7/10 to a realistic 9/10 with the
single highest-leverage Phase 2b change.

**Out of scope (deferred):**
- Swapping to a multilingual embedding model (bge-m3, multilingual-e5). That is
  the long-term correct fix but requires re-embedding all chunks and a config
  contract change; tracked as future Phase 2b-2.
- Populating `SearchResponse.chunks[]` (Phase 1 debt #9) — separate spec.
- Multi-account ingest (EU/AU/JP) — separate spec.

---

## 2. Decisions Locked During Brainstorming

| Question | Decision |
|---|---|
| Approach | **Query rewriting** (LLM translation), not embedding swap |
| Trigger | **CJK regex** `re.compile(r"[一-鿿]")` — deterministic, zero-cost detect |
| Output to LightRAG | **English only** — preserve proper nouns via prompt |
| Failure handling | **Soft fallback** to original CN query; never block `/search` |

---

## 3. Architecture

### 3.1 Module boundary

New file: `services/rag/src/paperclip_rag/query_translator.py`

Public surface — one async function and one dataclass:

```python
from dataclasses import dataclass
from typing import Literal

TranslationStatus = Literal["passthrough", "translated", "fallback"]

@dataclass(frozen=True)
class TranslationResult:
    text: str               # what to feed LightRAG
    original: str           # input as-is
    status: TranslationStatus
    detect_ms: int
    translate_ms: int       # 0 if passthrough
    fallback_reason: str | None = None   # only when status == "fallback"

async def translate_if_cjk(
    query: str,
    lm_client: "LMStudioClient",
    *,
    llm_model: str | None = None,   # None → use lm_client.llm_model
    timeout_s: float = 5.0,
) -> TranslationResult: ...
```

**Why a separate module:** isolated unit tests (no FastAPI), single file to
change when swapping detection strategy or LLM, no business logic creeping
into the LM Studio HTTP wrapper.

**Why not inside `lm_studio.py`:** that file is the transport-layer client
(embed / chat / healthcheck). Translation is application logic.

### 3.2 Touchpoints in existing code

| File | Change |
|---|---|
| `services/rag/src/paperclip_rag/api.py` | `/search` handler: 3 inserted lines to call `translate_if_cjk` and use `result.text` in `rag.aquery(...)` |
| `services/rag/src/paperclip_rag/schemas.py` | `SearchRequest.translate: Literal["auto","off"] = "auto"`; new `SearchMeta`; `SearchResponse.meta: SearchMeta \| None` |
| `services/rag/src/paperclip_rag/config.py` | Add optional `translation_llm_model: str \| None = None` (None → fallback to `llm_model`); enables later perf tuning without code changes |
| `services/rag/tests/test_api.py` | New cases for translate=auto / translate=off / meta echoing |
| `services/rag/tests/test_query_translator.py` | New file — unit tests for the module (see §6) |
| `services/rag/scripts/eval_search.py` | Print `meta.translation` per query; support `--translate off` flag for A/B |

No changes to `lightrag_factory.py`, `lm_studio.py`, `manifest.py`, or any
ingest module.

---

## 4. Data Flow

```
POST /search { collection, query, mode, top_k, translate="auto" }
    │
    ▼
detect_cjk(query)                                    # regex, <1ms
    │
    ├── no CJK ──────────────────────────► query_for_rag = query
    │                                      meta.translation = "passthrough"
    │
    └── has CJK and translate == "auto" ──► await translate_cn_to_en(...)
                                              │
                                              ├── ok   → query_for_rag = translated
                                              │         meta.translation = "translated"
                                              ├── fail → query_for_rag = original
                                                        meta.translation = "fallback"
                                                        meta.fallback_reason = <enum>

rag.aquery(query_for_rag, ...)                       # 3-8s (unchanged)
    │
    ▼
SearchResponse { answer, chunks, entities, relations, meta }
```

**Invariant:** translation failure never bubbles to the client as a 5xx.
The client always gets an `answer`. `meta` is the only signal that
translation degraded — clients that ignore `meta` see strictly Phase-2a-or-better
behaviour.

---

## 5. LLM Choice & Prompt

### 5.1 Model

v1: reuse `qwen3-30b-a3b-2507` (already loaded in LM Studio). Zero extra
memory, zero extra config.

Tuning path (config-only, no code): set `PAPERCLIP_RAG_TRANSLATION_LLM_MODEL`
env to switch to a smaller dedicated model (e.g. `qwen3-4b`) if the 300-800ms
LLM round-trip becomes the bottleneck.

### 5.2 Prompt (module-level constant in `query_translator.py`)

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

Call parameters:
- `temperature = 0` (deterministic)
- `max_tokens = 200` (ceiling at ~2× expected output length)
- `asyncio.wait_for(..., timeout=5.0)` — drives the timeout fallback

### 5.3 Output sanity checks (before accepting the translation)

A translation is accepted **only if all hold**:
- non-empty after strip
- output length ≤ 10× input length (defends against LLM emitting paragraphs of explanation)
- does not contain CJK characters (defends against the model copying input back unchanged or partially)

Any check fails → `status="fallback"`, `fallback_reason="output_check:<which>"`.

---

## 6. Error Handling Matrix

| Scenario | Action | `meta.translation` | `fallback_reason` | Log level |
|---|---|---|---|---|
| Pure English query | skip translate | `passthrough` | — | DEBUG |
| Translation OK + all sanity checks pass | use English | `translated` | — | INFO |
| `asyncio.TimeoutError` (>5s) | use original | `fallback` | `timeout` | WARNING |
| `LMStudioUnavailable` raised | use original | `fallback` | `lm_down` | WARNING |
| `ModelNotLoaded` raised | use original | `fallback` | `model_unloaded` | WARNING |
| Empty / whitespace-only output | use original | `fallback` | `output_check:empty` | WARNING |
| Output >10× input length | use original | `fallback` | `output_check:length` | WARNING |
| Output still contains CJK | use original | `fallback` | `output_check:cjk_residue` | WARNING |
| `translate="off"` in request | skip translate | `passthrough` | — | DEBUG |

All WARNING logs include `query_len`, `translate_ms`, and `fallback_reason`
as structured fields, never the raw query text (PII / log noise).

---

## 7. Observability

### 7.1 Per-`/search` structured log line

```
search collection=refund_comments query_len=18 cjk=true translation=translated translate_ms=312 aquery_ms=4821
```

Enables single-grep metrics like:
- `grep 'translation=fallback' _logs/rag/*.log | wc -l` → fallback rate
- `awk -F'translate_ms=' '{print $2}'` → translate latency distribution

### 7.2 `/healthz`

Unchanged. Translation is best-effort; LM Studio health already reported.

### 7.3 Eval script

`scripts/eval_search.py` extended:
- New `--translate {auto,off}` flag.
- Per-query output includes `translation`, `translate_ms`, and (when
  `translated`) the English text actually queried.
- Designed for A/B: run the same 10 fixed queries twice, once with
  `--translate off` (baseline = Phase 2a 7/10), once with `--translate auto`.

---

## 8. Testing Strategy

### 8.1 Unit — `tests/test_query_translator.py` (new)

| Test | Asserts |
|---|---|
| `test_detect_cjk_pure_english` | `False` |
| `test_detect_cjk_pure_chinese` | `True` |
| `test_detect_cjk_mixed_with_sku` | `True` (e.g. `"Fifi 退货率"`) |
| `test_detect_cjk_with_emoji_only` | `False` |
| `test_passthrough_makes_zero_llm_calls` | `lm_client.chat.call_count == 0`, status `passthrough` |
| `test_translate_success` | status `translated`, `result.text` matches mocked LLM output |
| `test_translate_timeout` | status `fallback`, reason `timeout`, text == original |
| `test_translate_lm_unavailable` | status `fallback`, reason `lm_down` |
| `test_translate_empty_output` | status `fallback`, reason `output_check:empty` |
| `test_translate_length_anomaly` | status `fallback`, reason `output_check:length` |
| `test_translate_cjk_residue_in_output` | status `fallback`, reason `output_check:cjk_residue` |
| `test_translate_off_request_skips` | even with CJK input, `translate="off"` → passthrough |

LM Studio is mocked end-to-end; tests run in <1s with no network.

### 8.2 API integration — `tests/test_api.py` (extend)

- `/search` with CJK query + `translate="auto"` + mock translator: verify the
  string passed to `factory.get(...).aquery()` is the **English** translation.
- `/search` with CJK query + `translate="off"`: verify the string passed is
  the **original Chinese**.
- `/search` response includes a well-formed `meta.translation` value.

### 8.3 Prompt regression — `tests/test_query_translator_prompt.py` (new, marked `@pytest.mark.real_lm`)

Skipped in CI by default. Run locally against a live LM Studio. Uses the
**exact 10 Phase 2a eval queries** as the canon. For each, asserts the
translation **contains** specific English keywords (substring match — not
exact equality, since LLM phrasing varies):

```python
CANON_QUERIES = [
    ("Fifi 这款的退货率怎么样？", ["Fifi", "return"]),
    ("尺码偏小的款式有哪些？", ["size", "small"]),
    ("被 FC 损坏的订单数量",        ["FC", "damaged"]),   # Phase 2a Q3 miss
    ("FC 仓库的责任问题",          ["FC", "responsib"]),  # Phase 2a Q9 miss
    # ... 6 more, full list locked in test file
]
```

Becomes the prompt-regression guard for all future prompt tweaks.

### 8.4 End-to-end eval (manual, gates the rollout)

Run `scripts/eval_search.py` twice on the locked Phase 2a 10-query rubric:
1. `--translate off` → expect 7/10 (Phase 2a baseline reproduced)
2. `--translate auto` → **acceptance ≥ 8/10**, target 9/10

Document delta in a follow-up `2026-05-18-phase2b1-eval-results.md`.

---

## 9. Performance Budget

| Stage | Budget | Notes |
|---|---|---|
| CJK detect | <1 ms | pre-compiled regex |
| translate LLM call | 300-800 ms p50 | qwen3-30b on M4 Max, ~1-2 sentence inputs |
| translate timeout | 5 s (hard) | drives fallback |
| `rag.aquery` | 3-8 s (unchanged) | dominant cost |
| **`/search` total overhead from this layer** | **<10% p50** | acceptable |

Trigger for the `translation_llm_model` escape hatch: if production p50
`translate_ms` consistently > 1500 ms, switch to qwen3-4b via env.

---

## 10. Backward Compatibility & Rollout

- `SearchRequest.translate` defaults to `"auto"` — existing clients keep
  working with no code change. Behaviour change for them is **strictly
  improving recall** for CN queries (or identical for EN).
- `SearchResponse.meta` is additive and optional. Clients that don't read it
  are unaffected.
- No KG rebuild required.
- No LM Studio model change required.
- Rollout = single PR + `pnpm rag:restart`. No data migration.

Rollback path: set `PAPERCLIP_RAG_TRANSLATE_DEFAULT=off` (TODO: add this env
short-circuit during implementation) — flips default for all clients.

---

## 11. Acceptance Criteria

A merge is GA-ready when **all** hold:

1. All unit tests in `test_query_translator.py` pass.
2. Extended `test_api.py` cases pass.
3. Prompt regression test (real-LM) passes locally on all 10 canon queries.
4. End-to-end eval (`--translate auto`) scores **≥ 8/10** on the locked
   Phase 2a rubric, with Q3 or Q9 (or both) flipping HIT.
5. `_logs/rag/` shows structured `translation=` field on every `/search`
   line during eval.
6. Tag: `rag-phase2b1-cn-en-ga`.

---

## 12. Open Questions Deferred to Implementation Plan

- Exact env var naming (`PAPERCLIP_RAG_TRANSLATION_LLM_MODEL` vs
  `PAPERCLIP_RAG_TRANSLATE_MODEL`).
- Whether to expose `translate_ms` in Prometheus / `/metrics` (no metrics
  endpoint today — out of scope here).
- Behaviour when `translate="auto"` and query is mixed (e.g. SKU + Chinese):
  current design translates the whole string; the LLM is instructed to
  preserve SKU. Verify via prompt regression test rather than special-case
  code.
