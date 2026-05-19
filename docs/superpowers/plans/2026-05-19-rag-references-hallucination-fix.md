# A2: References Hallucination Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop qwen3 from emitting fabricated `### References` blocks (`Document Title One/Two/Three`) by overriding LightRAG's stock `rag_response` prompt via `aquery_llm(system_prompt=...)` and disabling the LLM response cache (which would otherwise serve stale hallucinated answers because its key omits `system_prompt`).

**Architecture:** Two prompt constants in `lightrag_factory.py` (one per LightRAG's two placeholder dialects: KG modes use `{context_data}`, naive uses `{content_data}`). A `system_prompt_for(mode)` selector picks the right one. Handler passes the result as `system_prompt=` kwarg. `LightRAG(...)` constructor gains `enable_llm_cache=False` so the override takes effect immediately on every query.

**Tech Stack:** Python 3.13, FastAPI, LightRAG-HKU 1.2+, pytest (`asyncio_mode = "auto"`).

**Spec:** `docs/superpowers/specs/2026-05-19-rag-references-hallucination-fix-design.md`

**Working dir for all commands:** `/Users/melodylu/PycharmProjects/paperclip/services/rag/`

---

## File Map

**Modified:**
- `services/rag/src/paperclip_rag/lightrag_factory.py` — Two prompt constants `RAG_RESPONSE_PROMPT_KG` / `RAG_RESPONSE_PROMPT_NAIVE`; selector `system_prompt_for(mode)`; `enable_llm_cache=False` added to the `LightRAG(...)` constructor call.
- `services/rag/src/paperclip_rag/api.py` — Import `system_prompt_for`; pass `system_prompt=system_prompt_for(req.mode.value)` to the `rag.aquery_llm(...)` call.
- `services/rag/tests/test_lightrag_factory.py` — 5 new tests for the two prompts + the selector.
- `services/rag/tests/test_api.py` — 1 new assertion in `test_search_returns_answer` verifying the handler passes `system_prompt=` containing the positive-framing marker.

No new files. No new dependencies.

---

### Task 1: Add two prompt constants + selector (lightrag_factory.py)

**Files:**
- Modify: `services/rag/src/paperclip_rag/lightrag_factory.py`
- Modify: `services/rag/tests/test_lightrag_factory.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_lightrag_factory.py`:

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
        # Positive-framing line present:
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_lightrag_factory.py -v -k "prompt or system_prompt_for"`
Expected: FAIL — `RAG_RESPONSE_PROMPT_KG`, `RAG_RESPONSE_PROMPT_NAIVE`, `system_prompt_for` are not importable.

- [ ] **Step 3: Add the two prompts + selector**

In `src/paperclip_rag/lightrag_factory.py`, add at module level (above `LightRAGFactory` class — after the existing imports and constants):

```python
# Custom rag_response prompt overrides — A2 (suppresses LightRAG's stock
# "Document Title One/Two/Three" References hallucination by removing all
# References-section instructions from the system prompt). LightRAG uses
# `{context_data}` for KG modes and `{content_data}` for naive (sic, naming
# inconsistency upstream), so we define both.

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

(Do NOT touch the existing `LightRAGFactory` class, `_E_COMMERCE_ADDON`, or `query_param()` function in this step. They live in the same file but are unrelated.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_lightrag_factory.py -v`
Expected: ALL pass (5 new tests + all pre-existing factory tests).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/lightrag_factory.py tests/test_lightrag_factory.py
git commit -m "feat(rag): add RAG_RESPONSE_PROMPT_KG/NAIVE + system_prompt_for selector"
```

---

### Task 2: Disable LLM response cache

The override is useless if cache serves stale answers. Constructor flag flip.

**Files:**
- Modify: `services/rag/src/paperclip_rag/lightrag_factory.py` (the `LightRAG(...)` call inside `LightRAGFactory.get`, around line 82-91)

This task has no isolated unit test of its own — the verification is "subsequent E2E smoke shows fresh prompt taking effect on a previously-cached query" (Task 4 smoke does this).

- [ ] **Step 1: Locate the constructor call**

Run: `sed -n '80,95p' src/paperclip_rag/lightrag_factory.py`

Expected output shows:
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
        )
```

- [ ] **Step 2: Add `enable_llm_cache=False`**

In the same file, replace the `LightRAG(...)` call with:

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
            enable_llm_cache=False,
        )
```

(One added kwarg, alphabetical positioning after `addon_params` for readability. The default upstream is `True`; we want `False` because the cache key omits `system_prompt`, which means our A2 override would silently serve stale hallucinated answers for any pre-A2-cached query. `enable_llm_cache_for_entity_extract` is a SEPARATE flag for ingest-time entity extraction caching and stays at its default of True.)

- [ ] **Step 3: Verify factory tests still pass**

Run: `uv run pytest tests/test_lightrag_factory.py -v`
Expected: All pass (no regression — `enable_llm_cache=False` is a valid kwarg on `LightRAG()`).

- [ ] **Step 4: Commit**

```bash
git add src/paperclip_rag/lightrag_factory.py
git commit -m "fix(rag): disable LLM response cache (cache key omits system_prompt)"
```

---

### Task 3: Wire `system_prompt=` into handler + update test

**Files:**
- Modify: `services/rag/src/paperclip_rag/api.py`
- Modify: `services/rag/tests/test_api.py`

- [ ] **Step 1: Add the failing assertion to `test_search_returns_answer`**

In `tests/test_api.py`, find the `test_search_returns_answer` function and append these lines at the end (just before its closing brace):

```python
    # A2: verify the handler passes our custom system_prompt to suppress the
    # References hallucination. The positive-framing marker is unique to our
    # override.
    call_kwargs = rag.aquery_llm.await_args.kwargs
    assert call_kwargs.get("system_prompt") is not None
    assert "只输出答案正文" in call_kwargs["system_prompt"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api.py::test_search_returns_answer -v`
Expected: FAIL — `assert call_kwargs.get("system_prompt") is not None` because the handler doesn't currently pass that kwarg.

- [ ] **Step 3: Update the handler import block**

In `src/paperclip_rag/api.py`, find the line:

```python
from .lightrag_factory import LightRAGFactory, query_param
```

Replace with:

```python
from .lightrag_factory import LightRAGFactory, query_param, system_prompt_for
```

(If your current import is multi-line because it was already formatted, just add `system_prompt_for` to the imported names.)

- [ ] **Step 4: Pass `system_prompt=` to `aquery_llm`**

In `src/paperclip_rag/api.py`, find the `aquery_llm` call inside the `search` handler:

```python
        result = await rag.aquery_llm(
            tx.text, param=query_param(req.mode.value, req.top_k)
        )
```

Replace with:

```python
        result = await rag.aquery_llm(
            tx.text,
            param=query_param(req.mode.value, req.top_k),
            system_prompt=system_prompt_for(req.mode.value),
        )
```

(No other handler logic changes. The `_extract_answer`, helper mappers, error handling, logging all stay exactly the same.)

- [ ] **Step 5: Run all tests to verify GREEN**

Run: `uv run pytest tests/test_api.py -v`
Expected: All 13 pass (the modified `test_search_returns_answer` now passes; the other 12 unaffected because they all already mock `aquery_llm` correctly).

- [ ] **Step 6: Run the whole non-integration suite**

Run: `uv run pytest -m "not integration" -v 2>&1 | tail -5`
Expected: ~85 passed (80 baseline post-A1 + 5 new factory tests). Zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/paperclip_rag/api.py tests/test_api.py
git commit -m "feat(rag): pass mode-aware system_prompt to aquery_llm — suppress References hallucination"
```

---

### Task 4: Live RAG smoke verify + tag

**Files:** none (manual verification + git tag)

- [ ] **Step 1: Restart RAG with new code**

```bash
pkill -f "uvicorn paperclip_rag" || true
sleep 2
cd /Users/melodylu/PycharmProjects/paperclip/services/rag
./scripts/run_dev.sh > /tmp/rag_a2.log 2>&1 &
```

Wait until healthz returns ok:
```bash
sleep 6 && curl -s -m 5 http://127.0.0.1:9001/healthz
```

Expected: `{"status":"ok","lm_studio":"up",...}`

- [ ] **Step 2: Smoke test — no References section in answer**

Run (one line):
```bash
rtk proxy curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"做工质量","top_k":5}' \
  > /tmp/a2_smoke.json
```

Then check the answer body:
```bash
jq -r '.answer' /tmp/a2_smoke.json | tail -30
```

Pass criteria — ALL must hold:
1. The output does NOT contain the literal string `### References`
2. The output does NOT contain `Document Title One`, `Document Title Two`, or `Document Title Three`
3. The output ends with a substantive sentence (not a heading or list separator)
4. The output is still in Chinese (language match preserved)

Explicit grep checks:
```bash
jq -r '.answer' /tmp/a2_smoke.json | grep -c "### References" || true
jq -r '.answer' /tmp/a2_smoke.json | grep -c "Document Title" || true
```

Both grep counts MUST be `0`. If either is `>0`, STOP and investigate (the prompt override may not be reaching qwen3, or the LM Studio cache is somehow still in play).

- [ ] **Step 3: Smoke — `chunks[]` still populated (A1 regression)**

```bash
jq '{n_chunks: (.chunks | length), n_entities: (.entities | length), n_relations: (.relations | length), answer_len: (.answer | length)}' /tmp/a2_smoke.json
```

Expected: `n_chunks > 0`, `n_entities > 0`, `answer_len > 100`. (A1 wiring intact.)

- [ ] **Step 4: B1 DingTalk tool regression**

```bash
node /Users/melodylu/PycharmProjects/paperclip/packages/tool-registry/dist/cli.js \
  rag search-refund-comments \
  --company a0f62167-5f88-475b-bdc0-3d4cb80184dc \
  --project bed68dec-ddf6-4aa1-b921-48c4630e92c6 \
  --issue A2-smoke --actor agent \
  --shop EP-US --query "做工质量" 2>&1 | rtk proxy jq -r '.answer' | grep -c "Document Title"
```

Expected: `0` (no hallucination in DingTalk-tool-mediated path either).

Also verify exit code 0 and tool still returns the expected shape:
```bash
node /Users/melodylu/PycharmProjects/paperclip/packages/tool-registry/dist/cli.js \
  rag search-refund-comments \
  --company a0f62167-5f88-475b-bdc0-3d4cb80184dc \
  --project bed68dec-ddf6-4aa1-b921-48c4630e92c6 \
  --issue A2-smoke --actor agent \
  --shop EP-US --query "做工质量" 2>&1 | rtk proxy jq 'keys'
```

Expected: `["answer", "meta"]`.

- [ ] **Step 5: Tag**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
git tag -a rag-a2-no-references-hallucination-ga -m "A2 GA: suppressed LightRAG References hallucination

Override PROMPTS['rag_response'] via aquery_llm(system_prompt=...).
Two prompts (KG vs naive placeholder dialects), mode-aware selector.
LLM response cache disabled (cache key omits system_prompt → would
serve stale answers otherwise).

Smoke verified: zero 'Document Title One/Two/Three' / '### References'
in /search output. A1 chunks/entities still populated. B1 tool path
clean.

Spec: docs/superpowers/specs/2026-05-19-rag-references-hallucination-fix-design.md
Plan: docs/superpowers/plans/2026-05-19-rag-references-hallucination-fix.md"
```

Verify: `git tag -l rag-a2-*` shows the new tag.

Do NOT push.

- [ ] **Step 6: Summary log entry**

Run: `git log --oneline master..HEAD`

Expected order:
1. `docs(a2): RAG references hallucination fix — design`  (committed pre-plan)
2. `docs(a2): RAG references hallucination fix — implementation plan`
3. `feat(rag): add RAG_RESPONSE_PROMPT_KG/NAIVE + system_prompt_for selector`
4. `fix(rag): disable LLM response cache (cache key omits system_prompt)`
5. `feat(rag): pass mode-aware system_prompt to aquery_llm — suppress References hallucination`

---

## Self-Review

**Spec coverage check** (against `2026-05-19-rag-references-hallucination-fix-design.md`):

| Spec section | Covered by |
|---|---|
| §3.1 Files touched | Tasks 1, 2, 3 |
| §3.2 Two prompts (KG + naive) | Task 1 |
| §3.2 Diff vs LightRAG stock (deleted References instructions, added Output Discipline, positive framing) | Task 1 (prompt body) |
| §3.3 Disable LLM cache | Task 2 |
| §3.4 Handler wiring (`system_prompt_for(req.mode.value)`) | Task 3 |
| §4 Error handling (unchanged from A1) | Task 3 (no error-path code touched, regression checked via existing tests still passing) |
| §5.1 New tests in `test_lightrag_factory.py` (5 tests) | Task 1 Step 1 (all 5 included) |
| §5.2 Updated test in `test_api.py` (canonical happy-path assertion) | Task 3 Step 1 |
| §5.3 Manual smoke verification | Task 4 |
| §6 Acceptance criteria 1-8 | Tasks 1-3 (unit tests), Task 4 (live smoke + tag) |
| §7 Rollback (1-line revert of the kwarg, or revert constants entirely) | Implicit — 3 separate commits each independently revertable |
| §8 Future path (when ingest gains real file_paths) | Documented in spec, no code today |

All covered.

**Placeholder scan:** No TBD / TODO / unspecified error handling. Every command has expected output. Every code block is complete.

**Type/name consistency:**
- `RAG_RESPONSE_PROMPT_KG` / `RAG_RESPONSE_PROMPT_NAIVE` / `system_prompt_for` consistent across Tasks 1, 3 and test references.
- LightRAG modes (`local`, `global`, `hybrid`, `mix`, `naive`, `bypass`) used consistently in `system_prompt_for` definition (Task 1) and test cases (Task 1 Step 1).
- The marker string `只输出答案正文` is the same in: prompt body (Task 1), prompt-test assertion (Task 1 Step 1), and handler-test assertion (Task 3 Step 1) — searchable single source of truth.
- `enable_llm_cache=False` in Task 2 matches the spec §3.3 — same kwarg name as LightRAG's `lightrag.py:452`.
