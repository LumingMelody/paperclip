# A1: Fix SearchResponse.chunks[] always-empty — Design

**Status:** Draft for review
**Date:** 2026-05-19
**Owner:** Paperclip RAG team
**Related:**
- Phase 2b-1 GA: `2026-05-18-cn-en-query-translation-design.md` (deferred this as follow-up #2)
- Phase 2b-1 eval: `2026-05-18-phase2b1-eval-results.md` (follow-up #2: "chunks[] still empty")
- B1 GA: `2026-05-18-rag-as-dingtalk-tool-design.md` (returned `{answer, meta}` only because chunks unreliable)

---

## 1. Context & Motivation

`SearchResponse.chunks[]`, `entities[]`, and `relations[]` have been defined
on the API since Phase 1 but never populated. The `/search` handler calls
`rag.aquery(query, param=...)` which returns ONLY the synthesized text
answer — the underlying retrieved chunks, entities, and relations are
computed and immediately discarded.

This causes three real downstream problems:

1. **No source transparency for end users.** Any client (web UI, DingTalk
   bot, eval script) wanting to show "the answer is based on these N
   customer comments" gets an empty list and has to either hide the
   feature or fake it.
2. **References hallucination** (Phase 2b-1 eval follow-up #3). qwen3-30b
   regularly emits "[1] Document Title One ... [2] Document Title Two"
   placeholder citations because no real references reach it (or the
   client). Real references would let the client render real links.
3. **B1 dispatch ceiling.** The DingTalk bot's `rag.searchRefundComments`
   tool spec explicitly noted "v1 returns `{answer, meta}` only, chunks
   deferred until A1 lands" — capping how far Claude can take chained
   source-citing reasoning.

**The fix is unusually clean:** LightRAG's `aquery()` is itself a wrapper
around `aquery_llm()` (verified at
`lightrag/.venv/.../lightrag.py:2622-2655`) that throws away everything
except `llm_response.content`. Switching to `aquery_llm()` returns the
complete `{data: {chunks, entities, relationships, references}, llm_response: {content}}`
shape in the SAME call — zero extra retrieval cost, zero extra LLM cost.

**Out of scope (deferred):**
- Phase 2b-2 multi-account ingest (B2)
- Phase 2b-2 multilingual embedding swap (C1)
- DingTalk bot `rag.searchRefundComments` v2 returning chunks to Claude
  (will come after A1 stabilizes; trivial schema bump in tool-registry)

---

## 2. Decisions Locked During Brainstorming

| Question | Decision |
|---|---|
| Which response fields to populate | All four: `chunks`, `entities`, `relations`, NEW `references` |
| References hallucination fix | Add `SearchReference` model + populate from LightRAG so clients can render real refs instead of inheriting hallucinated `[1] Document Title One` from qwen3 |
| Cost trade-off | Use LightRAG's existing `aquery_llm()` — single call returns both answer and data, zero extra cost |
| Backward compatibility | All new fields optional; existing clients that ignore them see no change; B1 tool's zod outputSchema parses non-strict so the extra fields are simply ignored |

---

## 3. Architecture

### 3.1 Files touched

| File | Change | Lines |
|---|---|---|
| `services/rag/src/paperclip_rag/api.py` | `/search` handler: replace `rag.aquery(...)` with `rag.aquery_llm(...)`, unwrap structured fields, plus four small `_to_*` mapper functions at file bottom | ~50 changed/added |
| `services/rag/src/paperclip_rag/schemas.py` | Add optional fields to `SearchChunk`/`KGEntity`/`KGRelation`; new `SearchReference` model; `SearchResponse.references: list[SearchReference]` | ~30 changed |
| `services/rag/tests/test_api.py` | Existing `_FakeRAG` mock changes `aquery` → `aquery_llm` returning full structure dict; existing 9 tests updated to match; 4 new tests for chunks/entities/relations/references | ~80 added |

No new files. No new dependencies.

### 3.2 Why no new module

The four `_to_*` helper functions (chunk dict → SearchChunk, etc.) are
mechanical Pydantic field renames. Extracting them into `mappers.py` or
similar would create a file that only `api.py` ever imports. YAGNI.
They live as private module-level functions at the bottom of `api.py`
(50 lines total).

---

## 4. Data Flow

```
POST /search {collection, query, mode, top_k, translate}
    │
    ▼
resolve_query(...)  → tx: TranslationResult        # unchanged
    │
    ▼
result = await rag.aquery_llm(tx.text, param=query_param(...))
    │
    ▼
result.llm_response.content    → SearchResponse.answer
result.data.chunks             → SearchResponse.chunks         (list[SearchChunk])
result.data.entities           → SearchResponse.entities       (list[KGEntity])
result.data.relationships      → SearchResponse.relations      (list[KGRelation])
result.data.references         → SearchResponse.references     (list[SearchReference])
SearchMeta(...)                → SearchResponse.meta
```

**Note on naming:** LightRAG calls the field `relationships` (plural noun
form); our schema's existing field is `relations`. We preserve `relations`
(no breaking change) and map `data["relationships"]` → `SearchResponse.relations`
inside the handler.

---

## 5. Schema Changes

`services/rag/src/paperclip_rag/schemas.py`:

```python
class SearchChunk(BaseModel):
    id: str
    text: str
    score: float | None = None
    file_path: str | None = None         # NEW — from LightRAG
    reference_id: str | None = None      # NEW — from LightRAG
    metadata: dict[str, Any] = Field(default_factory=dict)


class KGEntity(BaseModel):
    name: str
    type: str | None = None
    description: str | None = None
    source_id: str | None = None         # NEW
    file_path: str | None = None         # NEW
    reference_id: str | None = None      # NEW


class KGRelation(BaseModel):
    src: str
    tgt: str
    description: str | None = None
    keywords: str | None = None          # NEW
    weight: float | None = None          # NEW
    source_id: str | None = None         # NEW
    file_path: str | None = None         # NEW
    reference_id: str | None = None      # NEW


class SearchReference(BaseModel):        # NEW model
    reference_id: str
    file_path: str


class SearchResponse(BaseModel):
    answer: str
    chunks: list[SearchChunk] = Field(default_factory=list)
    entities: list[KGEntity] = Field(default_factory=list)
    relations: list[KGRelation] = Field(default_factory=list)
    references: list[SearchReference] = Field(  # NEW
        default_factory=list
    )
    meta: SearchMeta | None = None
```

All additions are **strictly additive**:
- Existing API clients that don't read these fields are unaffected.
- Existing client parsers that DO read `chunks` but expect score (none today) keep getting `None`.
- B1's tool-registry zod schema (`packages/tool-registry/src/tools/rag/searchRefundComments.ts:32-46`) only validates `answer` + `meta`; extra fields pass through.

---

## 6. Handler Implementation

`api.py:120-156` `search` function — only the body changes; signature unchanged.

```python
@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest) -> SearchResponse:
    rag = await factory.get(req.collection)

    tx: TranslationResult = await resolve_query(
        req.query,
        translate=req.translate,
        lm_client=lm_client,
        llm_model=settings.translation_llm_model,
    )

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

    meta = SearchMeta(
        translation=tx.status,
        original_query=tx.original if tx.status != "passthrough" else None,
        translated_query=tx.text if tx.status == "translated" else None,
        translate_ms=tx.translate_ms if tx.status != "passthrough" else None,
        fallback_reason=tx.fallback_reason,
    )
    logger.info(
        "search collection={} query_len={} cjk={} translation={} translate_ms={} aquery_ms={}",
        req.collection, len(req.query),
        str(contains_cjk(req.query)).lower(),
        tx.status, tx.translate_ms, aquery_ms,
    )
    if tx.status == "fallback":
        logger.warning(
            "search translation fallback collection={} query_len={} reason={} translate_ms={}",
            req.collection, len(req.query), tx.fallback_reason, tx.translate_ms,
        )

    return SearchResponse(
        answer=answer,
        chunks=[_to_chunk(c) for c in data.get("chunks") or []],
        entities=[_to_entity(e) for e in data.get("entities") or []],
        relations=[_to_relation(r) for r in data.get("relationships") or []],
        references=[_to_reference(r) for r in data.get("references") or []],
        meta=meta,
    )
```

Helper functions at file bottom (private, single-purpose):

```python
def _extract_answer(result: dict) -> str:
    """Pull the text answer out of aquery_llm's polymorphic return shape.

    LightRAG `aquery_llm` return cases (verified at lightrag.py:2884-3020):
      - mode in {local,global,hybrid,mix,naive}, stream=False:
          llm_response = {"content": str, "is_streaming": False}
      - mode in {local,global,hybrid,mix,naive}, stream=True:
          llm_response = {"content": None, "response_iterator": AsyncIterator,
                          "is_streaming": True}
      - mode == "bypass": same content vs iterator split as above
      - status == "failure": llm_response.content may be None or absent;
                              top-level `message` carries the error text
    Our QueryParam defaults to stream=False (see lightrag_factory.py:99-100)
    so the streaming path SHOULDN'T fire — but we handle it defensively by
    surfacing a clear "[streaming-not-collected]" sentinel instead of "".
    """
    if result.get("status") == "failure":
        # The data block may be empty in this case; surface the failure
        # message as the answer so the client/user sees what went wrong.
        return str(result.get("message") or "")
    llm_response = result.get("llm_response") or {}
    if llm_response.get("is_streaming"):
        # Defensive: we never request streaming, so this is unexpected.
        # Don't try to consume the iterator here (sync FastAPI handler);
        # surface a sentinel and rely on logs.
        logger.warning("aquery_llm returned streaming response; ignored")
        return "[streaming response not collected]"
    return str(llm_response.get("content") or "")


def _to_chunk(c: dict) -> SearchChunk:
    return SearchChunk(
        id=str(c.get("chunk_id") or c.get("id") or ""),
        text=str(c.get("content") or ""),
        file_path=c.get("file_path"),
        reference_id=c.get("reference_id"),
    )


def _to_entity(e: dict) -> KGEntity:
    return KGEntity(
        name=str(e.get("entity_name") or ""),
        type=e.get("entity_type"),
        description=e.get("description"),
        source_id=e.get("source_id"),
        file_path=e.get("file_path"),
        reference_id=e.get("reference_id"),
    )


def _to_relation(r: dict) -> KGRelation:
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


def _to_reference(r: dict) -> SearchReference:
    return SearchReference(
        reference_id=str(r.get("reference_id") or ""),
        file_path=str(r.get("file_path") or ""),
    )
```

`str(... or "")` defends against LightRAG returning None for required fields — would
otherwise raise Pydantic validation error mid-response.

---

## 7. Error Handling

| Scenario | Behavior |
|---|---|
| Happy path (non-streaming, status="success") | All fields populated from LightRAG `data.*`; `answer` = `llm_response.content` |
| `LMStudioUnavailable` from `aquery_llm` | Same as before: 503 |
| `aquery_llm` returns `{"status": "failure", ...}` | Treat as success-with-empty-data: `answer = result["message"]`, all data fields empty. No exception. (Note: LightRAG status enum is `"success"` / `"failure"`, NOT `"error"` — verified at lightrag.py source.) |
| `llm_response.is_streaming == True` | Surface sentinel `"[streaming response not collected]"` as `answer` + WARN log; our `QueryParam(stream=False)` default should prevent this firing in practice |
| `bypass` mode (data block empty) | data list fields default to `[]`; `answer` still populated from `llm_response.content` |
| `data` key missing or null | All four list fields default to `[]` via `.get(..., None) or []` guard |
| Individual chunk/entity/relation has null required field | Helper coerces with `str(... or "")` — never raises Pydantic ValidationError mid-response |
| LightRAG chunk uses `id` instead of `chunk_id` (or vice versa across versions) | `_to_chunk` tries `chunk_id` first, then `id` fallback |

The handler is defensive against LightRAG schema drift — if LightRAG's
`data.references` key is renamed in a future version, the worst case is
that field becomes empty in the response, NOT a 5xx.

---

## 8. Testing

`services/rag/tests/test_api.py` — update existing + add 4 new.

### 8.1 Existing tests — narrow mock change (5 tests touch `/search`)

The current `_FakeRAG` class:
```python
class _FakeRAG:
    def __init__(self):
        self.ainsert = AsyncMock(return_value=None)
        self.aquery = AsyncMock(return_value="canned answer")
```

becomes:
```python
class _FakeRAG:
    def __init__(self):
        self.ainsert = AsyncMock(return_value=None)
        self.aquery_llm = AsyncMock(return_value={
            "status": "success",
            "message": "Query executed successfully",
            "data": {"entities": [], "relationships": [], "chunks": [], "references": []},
            "metadata": {},
            "llm_response": {"content": "canned answer", "is_streaming": False},
        })
```

Only the 5 `/search`-touching tests need their assertions updated
(`rag.aquery.await_args` → `rag.aquery_llm.await_args`):

1. `test_search_returns_answer`
2. `test_search_translates_cjk_query`
3. `test_search_off_keeps_original_cn`
4. `test_search_meta_for_pure_english`
5. `test_search_meta_for_fallback`

The other 4 tests (`test_healthz_ok`, `test_collections_lists_cached`,
`test_index_small_batch_calls_ainsert`, `test_healthz_503_when_lm_studio_down`)
never touch `aquery` and require no changes.

### 8.2 New tests

```python
def test_search_returns_chunks_when_lightrag_provides_them(app_and_rag):
    app, rag = app_and_rag
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
        "llm_response": {"content": "x"},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "EE02968 complaints"})
    body = r.json()
    assert len(body["chunks"]) == 3
    assert body["chunks"][0]["id"] == "c1"
    assert body["chunks"][0]["text"] == "Too small, chest tight"
    assert body["chunks"][0]["file_path"] == "refund_comments/EE02968.json"
    assert body["chunks"][0]["reference_id"] == "ref-1"


def test_search_returns_entities_and_relations(app_and_rag):
    app, rag = app_and_rag
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
                 "weight": 0.85, "source_id": "c1", "reference_id": "ref-1"},
            ],
            "references": [],
        },
        "llm_response": {"content": "x"},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "EE02968"})
    body = r.json()
    assert len(body["entities"]) == 1
    assert body["entities"][0]["name"] == "EE02968"
    assert body["entities"][0]["type"] == "SKU"
    assert len(body["relations"]) == 1
    assert body["relations"][0]["src"] == "EE02968"
    assert body["relations"][0]["tgt"] == "APPAREL_TOO_SMALL"
    assert body["relations"][0]["weight"] == 0.85


def test_search_returns_references(app_and_rag):
    app, rag = app_and_rag
    rag.aquery_llm = AsyncMock(return_value={
        "status": "success",
        "data": {
            "chunks": [], "entities": [], "relationships": [],
            "references": [
                {"reference_id": "ref-1", "file_path": "refund_comments/EE02968.json"},
                {"reference_id": "ref-2", "file_path": "refund_comments/EG01923.json"},
            ],
        },
        "llm_response": {"content": "x"},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "x"})
    body = r.json()
    assert len(body["references"]) == 2
    assert body["references"][0]["reference_id"] == "ref-1"
    assert body["references"][1]["file_path"] == "refund_comments/EG01923.json"


def test_search_handles_missing_data_block(app_and_rag):
    """LightRAG returns {status: error} or partial data → handler must NOT crash."""
    app, rag = app_and_rag
    rag.aquery_llm = AsyncMock(return_value={
        "status": "error",
        "message": "KG corrupted",
        "data": {},
        "llm_response": {"content": ""},
    })
    client = TestClient(app)
    r = client.post("/search", json={"collection": "decisions", "query": "x"})
    assert r.status_code == 200
    body = r.json()
    assert body["chunks"] == []
    assert body["entities"] == []
    assert body["relations"] == []
    assert body["references"] == []
```

### 8.3 No new integration test marker

The existing `integration` marker tests (`test_query_translator_prompt.py`)
don't touch `/search` response shape — they exercise the translator only.
Nothing to add at the integration layer.

### 8.4 Smoke verification (post-merge, manual)

1. Restart RAG service.
2. `curl -s -X POST http://127.0.0.1:9001/search \
       -H 'content-type: application/json' \
       -d '{"collection":"refund_comments","query":"做工质量"}' | jq '.chunks | length'`
3. Expect: integer > 0 (was always 0 before).
4. `... | jq '.references | length'` — expect > 0 (was field-doesn't-exist before).

---

## 9. Acceptance Criteria

| # | Criterion | Verification |
|---|---|---|
| 1 | All `tests/test_api.py` pass (9 existing + 4 new = 13) | `uv run pytest tests/test_api.py -v` |
| 2 | All other RAG-service tests still pass | `uv run pytest -m "not integration"` shows ~74 passed |
| 3 | `/search` returns non-empty `chunks[]` for a real CJK query against `refund_comments` | manual curl + jq |
| 4 | `/search` returns non-empty `references[]` | manual curl + jq |
| 5 | B1's `rag.searchRefundComments` CLI smoke still passes (regression check — the tool ignores extra fields) | `node packages/tool-registry/dist/cli.js rag search-refund-comments ... --shop EP-US --query 做工` |
| 6 | DingTalk bot smoke (`@ EE02968 顾客主要在抱怨什么`) still produces a 三段式 answer (the tool returns more data but Claude already only reads `answer`+`meta`) | manual DingTalk message |
| 7 | Tag `rag-a1-chunks-ga` (local, unpushed) | `git tag -l rag-a1-chunks-ga` |

---

## 10. Rollback

Three layers, severity-tiered:

- **Schema additions break some unknown downstream parser:** revert just the
  schemas.py commit. Handler keeps populating data, but new optional fields
  vanish from response. Old clients fine.
- **`aquery_llm` returns shape we didn't anticipate (KeyError mid-response):**
  revert just the api.py commit. `aquery()` works again, chunks return to
  empty.
- **Both layers broken:** revert both commits, fall back to Phase 2b-1
  behaviour (empty chunks/entities/relations, no references field).

No data migration. No persistent state changes.

---

## 11. Resolved Pre-Implementation Verifications

- **LightRAG version pin:** `services/rag/pyproject.toml` requires
  `lightrag-hku>=1.2.0`. `aquery_llm` exists in 1.2.0 (verified by reading
  source at `lightrag.py:2884`).
- **`aquery_llm` return shape:** documented in
  `lightrag/lightrag.py:2680-2746` docstring AND verified by tracing the
  function body — confirmed always contains `llm_response` and `data` keys
  on the success path.
- **`relationships` vs `relations` naming:** LightRAG uses `relationships`
  (consistent with KG terminology); our existing schema field is
  `relations` (consistent with our existing client contract). The mapping
  happens inside the handler — schema name stays stable.
- **B1 tool-registry zod parsing:** the descriptor schema for
  `rag.searchRefundComments` (paperclip repo,
  `packages/tool-registry/src/tools/rag/searchRefundComments.ts`) only
  validates `answer` + optional `meta`. zod's default `.object()` is
  **strip** mode (silently drops unknown keys) — adding `chunks` /
  `entities` / `relations` / `references` to the response will NOT cause
  B1 tool calls to fail validation; the extra fields are simply absent
  from the parsed handler return value. Net effect: same as today.
- **LightRAG status enum:** the spec originally wrote `"error"`; LightRAG
  actually emits `"success"` and `"failure"`. Verified by grepping
  `lightrag.py` for `"status":` literals. Spec text and tests updated to
  use `"failure"`.
- **`aquery_llm` polymorphic return shape:** confirmed via
  `lightrag.py:2884-3020` source that:
  - streaming vs non-streaming split lives in `llm_response.is_streaming`
  - failure path returns `{"status": "failure", "message": str, "data": {}, ...}`
  - bypass mode returns empty `data` but valid `llm_response`
  - all are handled by `_extract_answer()` and `.get(..., None) or []` guards
