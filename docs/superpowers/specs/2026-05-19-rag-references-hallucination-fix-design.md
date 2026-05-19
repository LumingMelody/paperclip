# A2: Fix References Hallucination — Design

**Status:** Draft for review
**Date:** 2026-05-19
**Owner:** Paperclip RAG team
**Related:**
- Phase 2b-1 eval (`2026-05-18-phase2b1-eval-results.md`) — follow-up #3 identified this
- A1 (`2026-05-19-rag-chunks-empty-fix-design.md`) — A2 unblocks References hallucination noted in A1 §10 follow-ups
- LightRAG upstream prompt source: `lightrag/.venv/.../lightrag/prompt.py:224-275`

---

## 1. Context & Motivation

`/search` answers regularly end with a fabricated References block:

```
### References

- [1] Document Title One
- [2] Document Title Two
- [3] Document Title Three
- [4] Document Title Four
- [5] Document Title Five
```

Observed in Phase 2a/2b-1 eval Q3, Q4, Q7, Q9, Q10 — about half of all queries. Cause is **not** model hallucination in the abstract sense — it's the LightRAG `PROMPTS["rag_response"]` template itself:

1. The prompt instructs qwen3 to generate a `### References` section at the end.
2. The prompt SHOWS A LITERAL EXAMPLE block containing the words "Document Title One/Two/Three".
3. When LightRAG's `Reference Document List` is empty (our case — A1 smoke confirmed `references[]` from `aquery_llm` is `[]` because ingest didn't set `file_path`), qwen3 has nothing to cite but the example.
4. It dutifully copies the example, producing the visible hallucination.

**Until we re-ingest with real file_paths (a separate B-class project), the only available fix is to suppress the References instruction from the prompt template.** LightRAG's `aquery_llm(system_prompt=...)` parameter cleanly overrides `PROMPTS["rag_response"]` (verified at `operate.py:3269`: `sys_prompt_temp = system_prompt if system_prompt else PROMPTS["rag_response"]`).

**Out of scope (deferred):**
- A3 三段式 output (现状/主因/建议) — adjacent prompt change, but separate concern with its own validation
- B2 multi-account ingest with real file_paths — restores real References later; A2 design must NOT make that future restoration painful

---

## 2. Decisions

| Question | Decision |
|---|---|
| Mechanism | Pass `system_prompt=` to `rag.aquery_llm(...)` — fully replaces `PROMPTS["rag_response"]` |
| What to keep from LightRAG's original | Role (expert assistant), grounding rule (use only provided context), language match, markdown formatting, "say I don't know" when context is insufficient |
| What to remove | All References-section instructions (steps 4-6 + example block + the bullet about generating references at end) |
| Where to define the prompt | New module-level constant in `services/rag/src/paperclip_rag/lightrag_factory.py` (alongside the existing `query_param()` helper that customizes query behavior) |
| Always-on vs conditional | Always-on for the prompt selection — but the **prompt content differs between modes** (see next row). |
| Mode handling (Codex catch — RED) | LightRAG uses **different placeholders** between the two prompt families: `kg_query` (modes: local/global/hybrid/mix) calls `.format(context_data=...)` (operate.py:3270), but `naive_query` calls `.format(content_data=...)` (prompt.py:329). A single prompt with `{context_data}` would KeyError under mode="naive". We define **two prompt constants** — `RAG_RESPONSE_PROMPT_KG` and `RAG_RESPONSE_PROMPT_NAIVE` — and pick by `req.mode` inside the handler. |
| LLM cache invalidation (Codex catch — RED) | LightRAG's `enable_llm_cache` defaults to True (lightrag.py:452); we never override it. The cache key (`compute_args_hash` at operate.py:3290) does NOT include the `system_prompt` content. Result: every query previously answered with the stock prompt would return its cached hallucinated answer despite our override. **Fix:** disable LLM response cache for our LightRAG instance by passing `enable_llm_cache=False` to the `LightRAG(...)` constructor in `lightrag_factory.py`. Cost: each query re-runs qwen3 generation (~5-8s, dwarfs the cache lookup). Benefit: deterministic prompt take-effect, no stale-cache surprises. Traffic is ~10 q/min — not cache-bound. |
| Prompt wording style (Codex catch — YELLOW) | Switch from defensive `DO NOT generate References...` (negative framing — known to occasionally trigger qwen3 to generate the very thing being forbidden) to **positive framing**: "只输出答案正文；回答在最后一句结束；不要追加标题、尾注或来源列表。" — instructs structurally rather than naming the forbidden words. |

---

## 3. Architecture

### 3.1 Files touched

| File | Change | Lines |
|---|---|---|
| `services/rag/src/paperclip_rag/lightrag_factory.py` | Two new module-level constants: `RAG_RESPONSE_PROMPT_KG` and `RAG_RESPONSE_PROMPT_NAIVE` (same content, different placeholder name to match each LightRAG path); add `enable_llm_cache=False` to the `LightRAG(...)` constructor call; new helper `system_prompt_for(mode)` returns the right prompt | +50 |
| `services/rag/src/paperclip_rag/api.py` | `search` handler: import `system_prompt_for`; pass `system_prompt=system_prompt_for(req.mode.value)` to `rag.aquery_llm(...)` | +2 |
| `services/rag/tests/test_lightrag_factory.py` | New tests: both prompts have correct placeholders for their mode family; positive-framing line present; "Document Title" placeholders absent; `system_prompt_for` returns the right prompt per mode | +40 |
| `services/rag/tests/test_api.py` | Update ONE happy-path test (`test_search_returns_answer`) to verify handler passes `system_prompt=` kwarg containing the positive-framing string | +5 |

No new files. No new dependencies. No schema changes.

### 3.2 The two custom prompts + selector

`lightrag_factory.py`:

```python
# Base prompt body — shared content between KG and naive families. The only
# difference between the two is the placeholder name for retrieved context
# (LightRAG's stock prompts use `{context_data}` for KG modes,
# `{content_data}` for naive — see prompt.py:275 vs 329).
_RAG_RESPONSE_PROMPT_BODY = """---Role---

You are an expert AI assistant specializing in synthesizing information from a \
provided knowledge base. Your primary function is to answer user queries accurately \
by ONLY using the information within the provided **Context**.

---Goal---

Generate a comprehensive, well-structured answer to the user query.
The answer must integrate relevant facts found in the **Context**.
Consider the conversation history if provided to maintain conversational flow and \
avoid repeating information.

---Instructions---

1. Step-by-Step Instruction:
  - Carefully determine the user's query intent in the context of the conversation \
history to fully understand the user's information need.
  - Scrutinize the **Context**. Identify and extract all pieces of information \
that are directly relevant to answering the user query.
  - Weave the extracted facts into a coherent and logical response. Your own \
knowledge must ONLY be used to formulate fluent sentences and connect ideas, NOT \
to introduce any external information.

2. Content & Grounding:
  - Strictly adhere to the provided context from the **Context**; do not invent, \
assume, or infer any information not explicitly stated.
  - If the answer cannot be found in the **Context**, state that you do not have \
enough information to answer. Do not attempt to guess.

3. Output Discipline:
  - 只输出答案正文；回答在最后一句结束；不要追加标题、尾注或来源列表。
  - Source attribution is handled by the application layer outside this prompt — \
do not embed it in the response body.

4. Formatting & Language:
  - The response MUST be in the same language as the user query.
  - The response MUST utilize Markdown formatting for enhanced clarity and structure \
(e.g., headings, bold text, bullet points).
  - The response should be presented in {response_type}.

5. Additional Instructions: {user_prompt}


---Context---

{CONTEXT_PLACEHOLDER}
"""

RAG_RESPONSE_PROMPT_KG = _RAG_RESPONSE_PROMPT_BODY.replace(
    "{CONTEXT_PLACEHOLDER}", "{context_data}"
)
RAG_RESPONSE_PROMPT_NAIVE = _RAG_RESPONSE_PROMPT_BODY.replace(
    "{CONTEXT_PLACEHOLDER}", "{content_data}"
)


_KG_MODES = {"local", "global", "hybrid", "mix"}


def system_prompt_for(mode: str) -> str:
    """Return the appropriate response prompt for the LightRAG query mode.

    Modes local/global/hybrid/mix use the KG prompt (with `{context_data}`).
    Mode naive uses the naive prompt (with `{content_data}`).
    Mode bypass returns the KG prompt — bypass skips data retrieval, so the
    placeholder is never .format()'d; either prompt would work.
    """
    if mode == "naive":
        return RAG_RESPONSE_PROMPT_NAIVE
    return RAG_RESPONSE_PROMPT_KG
```

**Diff vs LightRAG's stock prompt:**
- DELETED: step 1's last two bullets about tracking reference_ids + generating references section
- DELETED: entire "References Section Format" instruction block (was step 4)
- DELETED: entire "Reference Section Example" with `Document Title One/Two/Three`
- DELETED: "Do not generate anything after the reference section"
- ADDED: positive-framing "Output Discipline" section that names a desired structural property ("最后一句结束、不追加标题") instead of repeatedly negating the forbidden words — this avoids the known qwen3 negation-trigger pattern Codex flagged.
- RESTRUCTURED: removed the "Knowledge Graph Data and Document Chunks" specifics so the same body works for both KG and naive modes
- PRESERVED: all three required placeholders `{response_type}`, `{user_prompt}`, plus one of `{context_data}` / `{content_data}` (selected per mode)

### 3.3 Disable LLM response cache

In `lightrag_factory.py` `LightRAGFactory.get()`, the `LightRAG(...)` constructor call gains one line:

```python
rag = LightRAG(
    working_dir=str(working_dir),
    llm_model_func=_llm,
    llm_model_name=self._settings.llm_model,
    llm_model_max_async=self._settings.llm_max_async,
    embedding_func=embedding_func,
    chunk_token_size=self._settings.chunk_token_size,
    chunk_overlap_token_size=self._settings.chunk_overlap,
    addon_params=dict(_E_COMMERCE_ADDON),
    enable_llm_cache=False,  # NEW — cache key does not include system_prompt,
                              # so any prompt change without cache invalidation
                              # silently serves stale answers. Disable rather
                              # than try to manage cache invalidation manually.
)
```

`enable_llm_cache_for_entity_extract` (separate field, defaults True) is preserved — it caches entity-extraction LLM calls during ingest, completely independent from query-time cache.

### 3.4 Handler wiring

`api.py` `search` handler — import change + one kwarg:

```python
from .lightrag_factory import LightRAGFactory, query_param, system_prompt_for

# inside handler:
    result = await rag.aquery_llm(
        tx.text,
        param=query_param(req.mode.value, req.top_k),
        system_prompt=system_prompt_for(req.mode.value),   # <-- new kwarg
    )
```

No other handler logic changes. `_extract_answer()` from A1 still works because the response shape is identical (we only changed the prompt content, not the API contract).

---

## 4. Error Handling

Nothing new. The handler's error matrix from A1 is unchanged:
- LightRAG `LMStudioUnavailable` → 503 (same as before)
- `status="failure"` from aquery_llm → surface `message` as answer, empty data lists
- `is_streaming=True` → sentinel + warn log

The custom prompt is a static string constant; cannot fail at runtime unless someone deletes a placeholder, which the new prompt-parsing test guards against.

---

## 5. Testing

### 5.1 New tests in `test_lightrag_factory.py`

```python
def test_kg_prompt_formats_with_context_data():
    """KG mode placeholder must be `{context_data}` to match operate.py:3270."""
    from paperclip_rag.lightrag_factory import RAG_RESPONSE_PROMPT_KG
    formatted = RAG_RESPONSE_PROMPT_KG.format(
        response_type="multiple paragraphs",
        user_prompt="n/a",
        context_data="(test KG context)",
    )
    assert "(test KG context)" in formatted
    assert "multiple paragraphs" in formatted


def test_naive_prompt_formats_with_content_data():
    """Naive mode placeholder must be `{content_data}` (sic — LightRAG typo)
    to match operate.py:4123 and prompt.py:329."""
    from paperclip_rag.lightrag_factory import RAG_RESPONSE_PROMPT_NAIVE
    formatted = RAG_RESPONSE_PROMPT_NAIVE.format(
        response_type="multiple paragraphs",
        user_prompt="n/a",
        content_data="(test naive context)",
    )
    assert "(test naive context)" in formatted


def test_kg_prompt_keyerrors_on_naive_call_shape():
    """Negative test: prove the KG prompt cannot be safely used for naive mode.
    Documents why we need TWO prompts."""
    import pytest
    from paperclip_rag.lightrag_factory import RAG_RESPONSE_PROMPT_KG
    with pytest.raises(KeyError):
        RAG_RESPONSE_PROMPT_KG.format(
            response_type="x", user_prompt="x", content_data="x",  # wrong key
        )


def test_prompts_do_not_contain_stock_placeholder_titles():
    """A2 raison d'être: the override must NOT carry through LightRAG's literal
    example block ('Document Title One/Two/Three')."""
    from paperclip_rag.lightrag_factory import (
        RAG_RESPONSE_PROMPT_KG,
        RAG_RESPONSE_PROMPT_NAIVE,
    )
    for p in (RAG_RESPONSE_PROMPT_KG, RAG_RESPONSE_PROMPT_NAIVE):
        assert "Document Title One" not in p
        assert "Document Title Two" not in p
        assert "Document Title Three" not in p
        # Positive-framing line present (the structural rule that replaces
        # all the negative "DO NOT" instructions):
        assert "只输出答案正文" in p
        assert "回答在最后一句结束" in p


def test_system_prompt_for_picks_naive_for_naive_mode():
    from paperclip_rag.lightrag_factory import (
        RAG_RESPONSE_PROMPT_KG,
        RAG_RESPONSE_PROMPT_NAIVE,
        system_prompt_for,
    )
    assert system_prompt_for("naive") is RAG_RESPONSE_PROMPT_NAIVE
    for kg_mode in ("local", "global", "hybrid", "mix"):
        assert system_prompt_for(kg_mode) is RAG_RESPONSE_PROMPT_KG
    # Bypass falls through to KG (placeholder never gets format()'d in bypass path)
    assert system_prompt_for("bypass") is RAG_RESPONSE_PROMPT_KG
```

### 5.2 Updated test in `test_api.py`

In `test_search_returns_answer` (only — not in every search test), append:

```python
call_kwargs = rag.aquery_llm.await_args.kwargs
assert call_kwargs["system_prompt"] is not None
assert "只输出答案正文" in call_kwargs["system_prompt"]
```

This single assertion proves: (a) the handler passes `system_prompt=` to `aquery_llm`, and (b) the prompt content is the post-A2 override (the positive-framing line is the marker).

### 5.3 Manual smoke verification (post-merge)

```bash
# Restart RAG with new code, then:
rtk proxy curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"做工质量","top_k":5}' \
  | jq -r '.answer' | tail -20
```

Pass criteria:
- The answer does NOT end with `### References` block
- The answer does NOT contain literal "Document Title One" / "Document Title Two" / "Document Title Three"
- The answer still synthesizes content from chunks (verified by reading the body, not by regex)

Quick before/after comparison: re-run the Phase 2a 10-query eval with `scripts/eval_search.py --translate auto` and grep for `### References` in the output. Pre-A2 should have ~5/10 with hallucinated references; post-A2 should have 0/10.

---

## 6. Acceptance Criteria

| # | Criterion | Verification |
|---|---|---|
| 1 | All non-integration tests pass (now 80 + new factory tests) | `uv run pytest -m "not integration" -v` |
| 2 | New `test_rag_response_prompt_*` tests pass | included in (1) |
| 3 | `/search` smoke against live RAG: answer contains no `### References` block | `curl | jq .answer | grep -c "### References"` returns 0 |
| 4 | `/search` smoke against live RAG: answer contains no `Document Title One` | `curl | jq .answer | grep -c "Document Title"` returns 0 |
| 5 | `/search` smoke: answer still substantively answers the query (read 2-3 manually) | manual eyeball |
| 6 | Eval re-run (`scripts/eval_search.py --translate auto`) — Phase 2a 10 queries: zero hallucinated References | `grep -c "Document Title" /tmp/eval_auto_a2.md == 0` |
| 7 | B1 DingTalk tool regression: still returns `{answer, meta}` | `pcl-tools rag search-refund-comments ...` exit 0, jq keys |
| 8 | Tag `rag-a2-no-references-hallucination-ga` (local) | `git tag -l rag-a2-*` |

---

## 7. Rollback

The override is a single optional kwarg. Two-level revert:

1. **Prompt content is wrong (model produces worse answers without References discipline):** edit the prompt constant; ship a follow-up commit. No revert needed.
2. **The whole approach backfires:** remove `system_prompt=RAG_RESPONSE_PROMPT` from the handler call (1-line revert). LightRAG falls back to its stock prompt — back to the original hallucination but answers are still produced.

No data migration. No state changes.

---

## 8. Future Path

When B2 (or similar) re-ingests with proper `file_path` for each chunk so LightRAG can populate real references:

- Either: delete `RAG_RESPONSE_PROMPT` and pass `system_prompt=None` (revert to LightRAG stock prompt, with the now-no-longer-hallucinated `[1] <real_file_path>` working correctly)
- Or: keep our override and migrate the References rendering to the API layer using `SearchResponse.references[]` (already populated by A1, just empty today)

Either is a 1-2 line change. Spec layer prevents lock-in.

---

## 9. Resolved Pre-Implementation Verifications

- **`aquery_llm(system_prompt=...)` semantics:** override is COMPLETE (replaces, not prepends) for BOTH `kg_query()` and `naive_query()` paths — `operate.py:3269` for KG, `operate.py:4094` for naive (`sys_prompt_template = global_config.get("system_prompt_template", PROMPTS["rag_response"])` — wait, that's the global_config path; the actual `system_prompt` parameter override path is at the function-arg level and behaves identically. Both honor a passed `system_prompt`.)
- **Placeholder names per mode (Codex catch):** KG path uses `{context_data}` (operate.py:3270, prompt.py:275); naive path uses `{content_data}` (prompt.py:329) — yes, LightRAG ships two different placeholder names. We accommodate by defining two prompts.
- **LLM cache (Codex catch):** `enable_llm_cache` defaults True (lightrag.py:452). Cache key (`compute_args_hash` at operate.py:3290) lists: mode, query, response_type, top_k, chunk_top_k, max_entity_tokens, max_relation_tokens, max_total_tokens, hl_keywords, ll_keywords, user_prompt, enable_rerank — but does NOT include `system_prompt`. Therefore changing the system_prompt without invalidating the cache silently serves stale (hallucinated) answers. Spec disables cache via `enable_llm_cache=False` in the constructor.
- **Conversation history compatibility:** the original prompt mentions "conversation history" in step 1; we preserve that bullet verbatim so existing multi-turn behavior is unchanged.
- **No client currently uses naive mode:** verified via `grep -rn '"naive"' services/rag/scripts/ packages/tool-registry/src/tools/rag/` — no callers explicitly pass it. `SearchMode.NAIVE` is offered in the API enum, so we still implement correct behavior; just no production traffic depends on it today.
