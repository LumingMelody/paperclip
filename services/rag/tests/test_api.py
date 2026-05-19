from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
from fastapi.testclient import TestClient

from paperclip_rag.api import build_app
from paperclip_rag.config import Settings


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


class _FakeFactory:
    def __init__(self, rag):
        self._rag = rag
        self.cached = ["decisions"]

    async def get(self, collection):  # noqa: ARG002
        return self._rag

    def cached_collections(self):
        return list(self.cached)


@pytest.fixture
def app_and_rag(monkeypatch, tmp_path):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    rag = _FakeRAG()
    factory = _FakeFactory(rag)
    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(return_value="up")
    lm_client.embed = AsyncMock(
        return_value=np.zeros((1, Settings().embedding_dim), dtype=np.float32)
    )
    app = build_app(
        settings=Settings(),
        factory=factory,  # type: ignore[arg-type]
        lm_client=lm_client,  # type: ignore[arg-type]
    )
    return app, rag


def test_healthz_ok(app_and_rag):
    app, _ = app_and_rag
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["lm_studio"] == "up"


def test_collections_lists_cached(app_and_rag):
    app, _ = app_and_rag
    with TestClient(app) as c:
        r = c.get("/collections")
    assert r.status_code == 200
    names = [x["name"] for x in r.json()["collections"]]
    assert "decisions" in names


def test_index_small_batch_calls_ainsert(app_and_rag):
    app, rag = app_and_rag
    payload = {
        "collection": "decisions",
        "docs": [
            {"id": "d1", "text": "hello world"},
            {"id": "d2", "text": "second doc"},
        ],
    }
    with TestClient(app) as c:
        r = c.post("/index", json=payload)
    assert r.status_code == 202
    body = r.json()
    assert body["indexed"] == 2
    assert body["job_id"] is None
    rag.ainsert.assert_awaited_once()


def test_search_returns_answer(app_and_rag):
    app, rag = app_and_rag
    payload = {"collection": "decisions", "query": "why?", "mode": "hybrid"}
    with TestClient(app) as c:
        r = c.post("/search", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "canned answer"
    rag.aquery_llm.assert_awaited_once()
    # A2: verify the handler passes our custom system_prompt to suppress the
    # References hallucination. The positive-framing marker is unique to our
    # override.
    call_kwargs = rag.aquery_llm.await_args.kwargs
    assert call_kwargs.get("system_prompt") is not None
    assert "只输出答案正文" in call_kwargs["system_prompt"]


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
        json={"collection": "decisions", "query": "退货率", "translate": "auto"},
    )
    assert r.status_code == 200
    body = r.json()
    # Verify the English string is what reached LightRAG
    assert rag.aquery_llm.await_args.args[0] == "return rate"
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
    assert rag.aquery_llm.await_args.args[0] == "退货率"
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


def test_healthz_503_when_lm_studio_down(monkeypatch, tmp_path):
    from paperclip_rag.lm_studio import LMStudioUnavailable

    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    rag = _FakeRAG()
    factory = _FakeFactory(rag)
    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(side_effect=LMStudioUnavailable("boom"))
    lm_client.embed = AsyncMock(side_effect=LMStudioUnavailable("boom"))
    app = build_app(
        settings=Settings(),
        factory=factory,  # type: ignore[arg-type]
        lm_client=lm_client,  # type: ignore[arg-type]
    )
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "lm_studio_down"


def test_search_meta_for_fallback(app_and_rag, monkeypatch):
    app, rag = app_and_rag
    from paperclip_rag import api as api_mod
    from paperclip_rag.query_translator import TranslationResult

    async def fake_resolve(query, *, translate, lm_client, llm_model=None, timeout_s=5.0):
        return TranslationResult(
            text=query,
            original=query,
            status="fallback",
            detect_ms=1,
            translate_ms=850,
            fallback_reason="lm_down",
        )

    monkeypatch.setattr(api_mod, "resolve_query", fake_resolve)
    client = TestClient(app)
    r = client.post(
        "/search",
        json={"collection": "decisions", "query": "退货率", "translate": "auto"},
    )
    assert r.status_code == 200
    body = r.json()
    # Fallback uses ORIGINAL query (Chinese) for rag.aquery_llm
    assert rag.aquery_llm.await_args.args[0] == "退货率"
    meta = body["meta"]
    assert meta["translation"] == "fallback"
    assert meta["original_query"] == "退货率"
    assert meta["translated_query"] is None
    assert meta["translate_ms"] == 850
    assert meta["fallback_reason"] == "lm_down"


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
