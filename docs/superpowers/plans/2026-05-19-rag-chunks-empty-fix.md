# A1: Fix SearchResponse.chunks[] empty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the previously always-empty `SearchResponse.chunks/entities/relations` fields plus a new `references` field by switching the `/search` handler from LightRAG's `aquery()` to its data-returning parent `aquery_llm()` — zero extra retrieval/LLM cost.

**Architecture:** Strictly-additive schema extensions + handler method swap. One file gets ~50 lines of helper-plus-handler changes; tests update 5 existing fixtures and add 4 new scenarios. All new schema fields are optional, so the B1 DingTalk tool and any other downstream consumers continue working unchanged.

**Tech Stack:** Python 3.13, FastAPI, Pydantic v2, LightRAG-HKU 1.2+, pytest (`asyncio_mode = "auto"`).

**Spec:** `docs/superpowers/specs/2026-05-19-rag-chunks-empty-fix-design.md`

**Working dir for all commands:** `/Users/melodylu/PycharmProjects/paperclip/services/rag/`

---

## File Map

**Modified:**
- `services/rag/src/paperclip_rag/schemas.py` — extend `SearchChunk`/`KGEntity`/`KGRelation` with optional LightRAG fields; new `SearchReference` model; `SearchResponse.references: list[SearchReference]`
- `services/rag/src/paperclip_rag/api.py` — `search` handler swaps `rag.aquery(...)` → `rag.aquery_llm(...)`; add 5 private helper functions (`_extract_answer` + 4 mappers) at file bottom
- `services/rag/tests/test_api.py` — `_FakeRAG.aquery` → `_FakeRAG.aquery_llm` with new return shape; update 5 existing search-test assertions; append 4 new tests
- `services/rag/tests/test_schemas.py` — append tests for new optional fields and `SearchReference` model

No new files. No new dependencies.

---

### Task 1: Schema additions

**Files:**
- Modify: `services/rag/src/paperclip_rag/schemas.py`
- Modify: `services/rag/tests/test_schemas.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_schemas.py`:

```python
def test_search_chunk_accepts_new_lightrag_fields():
    from paperclip_rag.schemas import SearchChunk
    c = SearchChunk(
        id="c1", text="hi",
        file_path="refund_comments/EE.json",
        reference_id="ref-1",
    )
    assert c.file_path == "refund_comments/EE.json"
    assert c.reference_id == "ref-1"
    # Backward compat: minimal construction still works
    c2 = SearchChunk(id="c2", text="hi2")
    assert c2.file_path is None
    assert c2.reference_id is None


def test_kg_entity_accepts_new_lightrag_fields():
    from paperclip_rag.schemas import KGEntity
    e = KGEntity(
        name="EE02968", type="SKU",
        source_id="c1", file_path="x.json", reference_id="ref-1",
    )
    assert e.source_id == "c1"
    assert e.file_path == "x.json"
    assert e.reference_id == "ref-1"
    # Backward compat
    e2 = KGEntity(name="x")
    assert e2.source_id is None


def test_kg_relation_accepts_new_lightrag_fields():
    from paperclip_rag.schemas import KGRelation
    r = KGRelation(
        src="A", tgt="B",
        keywords="size,fit", weight=0.85,
        source_id="c1", file_path="x.json", reference_id="ref-1",
    )
    assert r.keywords == "size,fit"
    assert r.weight == 0.85
    assert r.source_id == "c1"
    # Backward compat
    r2 = KGRelation(src="A", tgt="B")
    assert r2.weight is None


def test_search_reference_model():
    from paperclip_rag.schemas import SearchReference
    ref = SearchReference(reference_id="ref-1", file_path="refund_comments/EE.json")
    assert ref.reference_id == "ref-1"
    assert ref.file_path == "refund_comments/EE.json"


def test_search_response_references_field_defaults_empty():
    from paperclip_rag.schemas import SearchResponse
    r = SearchResponse(answer="hi")
    assert r.references == []


def test_search_response_references_roundtrip():
    from paperclip_rag.schemas import SearchResponse, SearchReference
    r = SearchResponse(
        answer="x",
        references=[
            SearchReference(reference_id="ref-1", file_path="a.json"),
            SearchReference(reference_id="ref-2", file_path="b.json"),
        ],
    )
    assert len(r.references) == 2
    assert r.references[0].reference_id == "ref-1"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_schemas.py -v -k "new_lightrag_fields or search_reference or references"`
Expected: FAIL — new field names don't exist on the existing models, `SearchReference` not importable.

- [ ] **Step 3: Update `schemas.py`**

Replace the three existing models in `src/paperclip_rag/schemas.py` (find by name):

```python
class SearchChunk(BaseModel):
    id: str
    text: str
    score: float | None = None
    file_path: str | None = None
    reference_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class KGEntity(BaseModel):
    name: str
    type: str | None = None
    description: str | None = None
    source_id: str | None = None
    file_path: str | None = None
    reference_id: str | None = None


class KGRelation(BaseModel):
    src: str
    tgt: str
    description: str | None = None
    keywords: str | None = None
    weight: float | None = None
    source_id: str | None = None
    file_path: str | None = None
    reference_id: str | None = None
```

Add a new `SearchReference` model (place it next to `KGRelation`):

```python
class SearchReference(BaseModel):
    reference_id: str
    file_path: str
```

Update `SearchResponse` to add `references`:

```python
class SearchResponse(BaseModel):
    answer: str
    chunks: list[SearchChunk] = Field(default_factory=list)
    entities: list[KGEntity] = Field(default_factory=list)
    relations: list[KGRelation] = Field(default_factory=list)
    references: list[SearchReference] = Field(default_factory=list)
    meta: SearchMeta | None = None
```

(Keep `SearchMeta` exactly as it is.)

- [ ] **Step 4: Run all schema tests to verify they pass**

Run: `uv run pytest tests/test_schemas.py -v`
Expected: ALL pass (new 6 tests + all pre-existing schema tests).

- [ ] **Step 5: Commit**

```bash
git add src/paperclip_rag/schemas.py tests/test_schemas.py
git commit -m "feat(rag): extend SearchResponse with LightRAG-aligned optional fields + SearchReference"
```

---

### Task 2: Update test fixtures + add 4 new handler tests (RED phase)

This task pre-writes all the `/search` handler tests to match the post-fix behavior. Most existing tests will turn RED at the end of this task because the handler still calls `aquery` (not `aquery_llm`). That's intentional — Task 3 makes them green.

**Files:**
- Modify: `services/rag/tests/test_api.py`

- [ ] **Step 1: Update `_FakeRAG` fixture to mock `aquery_llm` instead of `aquery`**

In `tests/test_api.py`, find the `_FakeRAG` class definition near the top and replace:

```python
class _FakeRAG:
    """Stand-in for a LightRAG instance."""
    def __init__(self):
        self.ainsert = AsyncMock(return_value=None)
        self.aquery_llm = AsyncMock(return_value={
            "status": "success",
            "message": "Query executed successfully",
            "data": {
                "entities": [],
                "relationships": [],
                "chunks": [],
                "references": [],
            },
            "metadata": {},
            "llm_response": {"content": "canned answer", "is_streaming": False},
        })
```

(The old `self.aquery = AsyncMock(return_value="canned answer")` line is fully replaced by the `aquery_llm` block above.)

- [ ] **Step 2: Update 5 existing search-test assertions**

In the same file, find each of the 5 tests below and replace any `rag.aquery.await_args.args[0]` with `rag.aquery_llm.await_args.args[0]`. The text assertions stay identical.

Tests to update (search the file by name):
1. `test_search_returns_answer` — change `rag.aquery.assert_awaited_once()` to `rag.aquery_llm.assert_awaited_once()` if present; assert response answer still equals `"canned answer"`.
2. `test_search_translates_cjk_query` — `rag.aquery.await_args.args[0] == "return rate"` → `rag.aquery_llm.await_args.args[0] == "return rate"`.
3. `test_search_off_keeps_original_cn` — `rag.aquery.await_args.args[0] == "退货率"` → `rag.aquery_llm.await_args.args[0] == "退货率"`.
4. `test_search_meta_for_pure_english` — same kind of substitution; no positional-arg assertion required, just verify response shape unchanged.
5. `test_search_meta_for_fallback` — `rag.aquery.await_args.args[0] == "退货率"` → `rag.aquery_llm.await_args.args[0] == "退货率"`.

Do NOT touch the other 4 tests in the file (`test_healthz_ok`, `test_collections_lists_cached`, `test_index_small_batch_calls_ainsert`, `test_healthz_503_when_lm_studio_down`). They don't reference `aquery` and require no changes.

- [ ] **Step 3: Append the 4 new tests**

Append to `tests/test_api.py`:

```python
def test_search_returns_chunks_when_lightrag_provides_them(app_and_rag, monkeypatch):
    app, rag = app_and_rag
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        return TranslationResult(
            text=query, original=query, status="passthrough",
            detect_ms=0, translate_ms=0,
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    rag.aquery_llm = AsyncMock(return_value={
        "status": "success",
        "data": {
            "chunks": [
                {"chunk_id": "c1", "content": "Too small, chest tight",
                 "file_path": "refund_comments/EE02968.json", "reference_id": "ref-1"},
                {"chunk_id": "c2", "content": "Fabric too thin",
                 "file_path": "refund_comments/EE02968.json", "reference_id": "ref-2"},
                {"chunk_id": "c3", "content": "Color faded after wash",
                 "file_path": "refund_comments/EE02968.json", "reference_id": "ref-3"},
            ],
            "entities": [], "relationships": [], "references": [],
        },
        "llm_response": {"content": "x", "is_streaming": False},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "EE02968 complaints"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["chunks"]) == 3
    assert body["chunks"][0]["id"] == "c1"
    assert body["chunks"][0]["text"] == "Too small, chest tight"
    assert body["chunks"][0]["file_path"] == "refund_comments/EE02968.json"
    assert body["chunks"][0]["reference_id"] == "ref-1"


def test_search_returns_entities_and_relations(app_and_rag, monkeypatch):
    app, rag = app_and_rag
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        return TranslationResult(
            text=query, original=query, status="passthrough",
            detect_ms=0, translate_ms=0,
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    rag.aquery_llm = AsyncMock(return_value={
        "status": "success",
        "data": {
            "chunks": [],
            "entities": [
                {"entity_name": "EE02968", "entity_type": "SKU",
                 "description": "style code", "source_id": "c1",
                 "file_path": "x", "reference_id": "ref-1"},
            ],
            "relationships": [
                {"src_id": "EE02968", "tgt_id": "APPAREL_TOO_SMALL",
                 "description": "returns due to size", "keywords": "size,fit",
                 "weight": 0.85, "source_id": "c1",
                 "file_path": "x", "reference_id": "ref-1"},
            ],
            "references": [],
        },
        "llm_response": {"content": "x", "is_streaming": False},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "EE02968"})
    body = r.json()
    assert len(body["entities"]) == 1
    assert body["entities"][0]["name"] == "EE02968"
    assert body["entities"][0]["type"] == "SKU"
    assert body["entities"][0]["source_id"] == "c1"
    assert len(body["relations"]) == 1
    assert body["relations"][0]["src"] == "EE02968"
    assert body["relations"][0]["tgt"] == "APPAREL_TOO_SMALL"
    assert body["relations"][0]["weight"] == 0.85
    assert body["relations"][0]["keywords"] == "size,fit"


def test_search_returns_references(app_and_rag, monkeypatch):
    app, rag = app_and_rag
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        return TranslationResult(
            text=query, original=query, status="passthrough",
            detect_ms=0, translate_ms=0,
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    rag.aquery_llm = AsyncMock(return_value={
        "status": "success",
        "data": {
            "chunks": [], "entities": [], "relationships": [],
            "references": [
                {"reference_id": "ref-1", "file_path": "refund_comments/EE02968.json"},
                {"reference_id": "ref-2", "file_path": "refund_comments/EG01923.json"},
            ],
        },
        "llm_response": {"content": "x", "is_streaming": False},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "x"})
    body = r.json()
    assert len(body["references"]) == 2
    assert body["references"][0]["reference_id"] == "ref-1"
    assert body["references"][1]["file_path"] == "refund_comments/EG01923.json"


def test_search_handles_failure_status_with_empty_data(app_and_rag, monkeypatch):
    """LightRAG returns {status:'failure', ...} → handler must NOT crash;
    answer carries the failure message; all data fields empty."""
    app, rag = app_and_rag
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        return TranslationResult(
            text=query, original=query, status="passthrough",
            detect_ms=0, translate_ms=0,
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    rag.aquery_llm = AsyncMock(return_value={
        "status": "failure",
        "message": "KG corrupted",
        "data": {},
        "llm_response": {"content": None, "is_streaming": False},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "x"})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "KG corrupted"
    assert body["chunks"] == []
    assert body["entities"] == []
    assert body["relations"] == []
    assert body["references"] == []
```

- [ ] **Step 4: Run tests to verify the expected RED state**

Run: `uv run pytest tests/test_api.py -v`
Expected: Several FAILURES across the 5 updated tests + the 4 new tests (all 9 tests that exercise `/search`). The 4 non-search tests still PASS. The failures should look like `AttributeError: _FakeRAG has no attribute 'aquery'` from inside the production handler, because the handler still calls `aquery` but the fixture only exposes `aquery_llm`.

If the failure modes don't match — i.e. tests pass unexpectedly, or fail with errors unrelated to `aquery`/`aquery_llm` — STOP and report. Task 3 assumes this exact RED state.

- [ ] **Step 5: Commit the RED state**

```bash
git add tests/test_api.py
git commit -m "test(rag): pre-write tests for chunks/entities/relations/references (RED)"
```

(Yes, committing a red test suite. This is intentional — it makes Task 3's green flip easier to review.)

---

### Task 3: Switch handler to `aquery_llm` + add helpers (GREEN)

**Files:**
- Modify: `services/rag/src/paperclip_rag/api.py`

- [ ] **Step 1: Add the 5 helper functions at file bottom**

Append to `src/paperclip_rag/api.py` (after the existing `create_app` function):

```python
def _extract_answer(result: dict[str, Any]) -> str:
    """Pull the text answer out of aquery_llm's polymorphic return shape.

    Handles: success+non-streaming (the common case), failure (surfaces
    `message`), and streaming (surfaces a sentinel — our QueryParam
    defaults to stream=False so this should not fire in practice).
    """
    if result.get("status") == "failure":
        return str(result.get("message") or "")
    llm_response = result.get("llm_response") or {}
    if llm_response.get("is_streaming"):
        logger.warning("aquery_llm returned streaming response; ignored")
        return "[streaming response not collected]"
    return str(llm_response.get("content") or "")


def _to_chunk(c: dict[str, Any]) -> SearchChunk:
    return SearchChunk(
        id=str(c.get("chunk_id") or c.get("id") or ""),
        text=str(c.get("content") or ""),
        file_path=c.get("file_path"),
        reference_id=c.get("reference_id"),
    )


def _to_entity(e: dict[str, Any]) -> KGEntity:
    return KGEntity(
        name=str(e.get("entity_name") or ""),
        type=e.get("entity_type"),
        description=e.get("description"),
        source_id=e.get("source_id"),
        file_path=e.get("file_path"),
        reference_id=e.get("reference_id"),
    )


def _to_relation(r: dict[str, Any]) -> KGRelation:
    return KGRelation(
        src=str(r.get("src_id") or ""),
        tgt=str(r.get("tgt_id") or ""),
        description=r.get("description"),
        keywords=r.get("keywords"),
        weight=r.get("weight"),
        source_id=r.get("source_id"),
        file_path=r.get("file_path"),
        reference_id=r.get("reference_id"),
    )


def _to_reference(r: dict[str, Any]) -> SearchReference:
    return SearchReference(
        reference_id=str(r.get("reference_id") or ""),
        file_path=str(r.get("file_path") or ""),
    )
```

The helpers reference `SearchChunk`, `KGEntity`, `KGRelation`, `SearchReference` — these must be imported at the top of `api.py`. Update the existing `from .schemas import (...)` block to include all four. After Task 1 these all live in `schemas.py`. The full import block should read:

```python
from .schemas import (
    CollectionInfo,
    CollectionsResponse,
    ErrorBody,
    ErrorResponse,
    HealthzResponse,
    IndexRequest,
    IndexResponse,
    KGEntity,
    KGRelation,
    SearchChunk,
    SearchMeta,
    SearchReference,
    SearchRequest,
    SearchResponse,
)
```

(Add the four `Search*`/`KG*` names if not already present. Keep existing imports.)

- [ ] **Step 2: Replace the `aquery` call site inside the `search` handler**

In `api.py`, find this block inside the `search` handler:

```python
    try:
        t_query = time.perf_counter()
        answer = await rag.aquery(
            tx.text, param=query_param(req.mode.value, req.top_k)
        )
        aquery_ms = int((time.perf_counter() - t_query) * 1000)
    except LMStudioUnavailable as e:
        raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})
```

Replace it with:

```python
    try:
        t_query = time.perf_counter()
        result = await rag.aquery_llm(
            tx.text, param=query_param(req.mode.value, req.top_k)
        )
        aquery_ms = int((time.perf_counter() - t_query) * 1000)
    except LMStudioUnavailable as e:
        raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})

    answer = _extract_answer(result)
    data = result.get("data") or {}
```

- [ ] **Step 3: Replace the final `return` of the `search` handler**

Find the current final return:

```python
    return SearchResponse(answer=str(answer), meta=meta)
```

Replace with:

```python
    return SearchResponse(
        answer=answer,
        chunks=[_to_chunk(c) for c in data.get("chunks") or []],
        entities=[_to_entity(e) for e in data.get("entities") or []],
        relations=[_to_relation(r) for r in data.get("relationships") or []],
        references=[_to_reference(r) for r in data.get("references") or []],
        meta=meta,
    )
```

(The `str(answer)` wrap is no longer needed — `_extract_answer` always returns `str`.)

- [ ] **Step 4: Run all `/search` tests to verify GREEN**

Run: `uv run pytest tests/test_api.py -v`
Expected: ALL pass (9 pre-existing + 4 new = 13 total in test_api.py).

- [ ] **Step 5: Run the whole non-integration suite to verify no regressions elsewhere**

Run: `uv run pytest -m "not integration" -v 2>&1 | tail -10`
Expected: total `~74 passed` (Phase 2b-1 baseline 70 + 4 new). Zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/paperclip_rag/api.py
git commit -m "feat(rag): switch /search to aquery_llm — populate chunks/entities/relations/references"
```

---

### Task 4: Smoke verify against live RAG + tag

**Files:** none (manual verification + git tags)

- [ ] **Step 1: Confirm RAG service is running**

Run: `curl -s -m 3 http://127.0.0.1:9001/healthz`
Expected: `{"status":"ok","lm_studio":"up",...}`

If not up, restart:
```bash
cd /Users/melodylu/PycharmProjects/paperclip/services/rag
./scripts/run_dev.sh > /tmp/rag_a1.log 2>&1 &
```
Wait until healthz returns ok.

**Important:** the running RAG process is using the OLD code unless it was started after Task 3's commit. If you started it earlier in this session, kill and restart now:
```bash
pkill -f "uvicorn paperclip_rag" || true
sleep 2
cd /Users/melodylu/PycharmProjects/paperclip/services/rag
./scripts/run_dev.sh > /tmp/rag_a1.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:9001/healthz
```

- [ ] **Step 2: Verify chunks come back from a real query**

Run (one line):
```bash
curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"做工质量","top_k":5}' \
  | jq '{n_chunks: (.chunks | length), n_entities: (.entities | length), n_relations: (.relations | length), n_references: (.references | length), first_chunk_id: .chunks[0].id, first_chunk_file: .chunks[0].file_path}'
```

Expected output shape (counts will vary):
```json
{
  "n_chunks": 5,
  "n_entities": 8,
  "n_relations": 12,
  "n_references": 5,
  "first_chunk_id": "chunk-xxx-xxx",
  "first_chunk_file": "<some file path>"
}
```

**Pass criterion:** `n_chunks > 0` AND `n_references > 0` AND `first_chunk_id != null` AND `first_chunk_id != ""`.

If `n_chunks == 0` but the same query worked in B1 smoke tests earlier (returning a non-empty `answer`), STOP — that means LightRAG's response shape differs from what the spec assumed. Capture the raw response with `curl ... | jq '.'` and report.

- [ ] **Step 3: Verify the answer field still works (regression)**

Run:
```bash
curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"做工质量","top_k":5}' \
  | jq -r '.answer' | head -c 400
```

Expected: non-empty Chinese text (the synthesized answer). Same content as before this change.

- [ ] **Step 4: Verify B1 DingTalk tool still works (regression)**

Run:
```bash
node /Users/melodylu/PycharmProjects/paperclip/packages/tool-registry/dist/cli.js \
  rag search-refund-comments \
  --company a0f62167-5f88-475b-bdc0-3d4cb80184dc \
  --project bed68dec-ddf6-4aa1-b921-48c4630e92c6 \
  --issue A1-smoke --actor agent \
  --shop EP-US --query "做工质量" 2>&1 | jq 'keys'
```

Expected output: `["answer", "meta"]` (the zod schema in `searchRefundComments.ts` strips the extra `chunks`/`entities`/`relations`/`references` keys — that's the designed-for behavior). Exit code 0.

If the response is `{"error": "ValidationError", ...}` — that means zod is NOT in strip mode. STOP and investigate (spec §11 promised strip semantics).

- [ ] **Step 5: Tag**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
git tag -a rag-a1-chunks-ga -m "A1 GA: /search returns chunks/entities/relations/references

aquery → aquery_llm swap; zero extra retrieval/LLM cost.
Backward compat preserved (all new fields optional; zod strip mode
in B1 tool drops them silently).

Spec: docs/superpowers/specs/2026-05-19-rag-chunks-empty-fix-design.md
Plan: docs/superpowers/plans/2026-05-19-rag-chunks-empty-fix.md"
```

Verify: `git tag -l rag-a1-chunks-ga` shows the new tag.

Do NOT push the tag.

- [ ] **Step 6: Final summary**

Run: `git log --oneline master..HEAD` (or `git log --oneline -5` if already on master) to confirm the A1 commits landed in expected order:
1. `feat(rag): extend SearchResponse with LightRAG-aligned optional fields + SearchReference`
2. `test(rag): pre-write tests for chunks/entities/relations/references (RED)`
3. `feat(rag): switch /search to aquery_llm — populate chunks/entities/relations/references`

---

## Self-Review

**Spec coverage check** (against `2026-05-19-rag-chunks-empty-fix-design.md`):

| Spec section | Covered by |
|---|---|
| §3.1 Files touched (schemas, api.py, test_api, test_schemas) | Tasks 1, 2, 3 |
| §3.2 No new module (helpers inline at api.py bottom) | Task 3 Step 1 |
| §4 Data flow (aquery_llm → unwrap → SearchResponse) | Task 3 Steps 2-3 |
| §5 Schema additions (3 model extensions + new SearchReference + SearchResponse.references) | Task 1 |
| §6 Handler implementation (5 helpers + handler swap) | Task 3 Steps 1-3 |
| §7 Error handling matrix (failure status, streaming, bypass, missing data) | Task 3 Step 1 (`_extract_answer` + `.get(..., None) or []` guards); Task 2 Step 3 (`test_search_handles_failure_status_with_empty_data`) |
| §8.1 Existing tests narrow mock change (5 tests) | Task 2 Step 2 |
| §8.2 New tests (chunks/entities-relations/references/failure) | Task 2 Step 3 (all 4 new tests included) |
| §8.4 Manual smoke verification | Task 4 Steps 2-4 |
| §9 Acceptance criteria items 1-7 | Tasks 1+2+3 (unit), Task 4 Steps 2-5 (smoke + tag) |
| §10 Rollback strategy | Implicit via 3 separate commits (schemas / tests / handler) — any one is independently revertable |

All covered.

**Placeholder scan:** No TBD / TODO / "add appropriate error handling" / missing code blocks. Every step has runnable commands with expected output.

**Type/name consistency check:**
- `SearchChunk` / `KGEntity` / `KGRelation` / `SearchReference` field names consistent between Tasks 1, 2, 3.
- Helper names `_extract_answer` / `_to_chunk` / `_to_entity` / `_to_relation` / `_to_reference` consistent in Task 3.
- LightRAG dict keys used in mocks (Task 2) match the keys consumed by helpers (Task 3): `chunk_id`/`content`/`entity_name`/`entity_type`/`src_id`/`tgt_id`/`relationships`/`reference_id`.
- `_FakeRAG.aquery_llm` mock shape (Task 2 Step 1) matches what `_extract_answer` and `data.get(...)` expect (Task 3).
- Mock literal `"status": "success"` / `"status": "failure"` matches `_extract_answer`'s check (Task 3 Step 1).
