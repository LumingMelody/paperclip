from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from paperclip_rag.api import build_app
from paperclip_rag.config import Settings


class _FakeRAG:
    """Stand-in for a LightRAG instance."""
    def __init__(self):
        self.ainsert = AsyncMock(return_value=None)
        self.aquery = AsyncMock(return_value="canned answer")


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
    rag.aquery.assert_awaited_once()


def test_healthz_503_when_lm_studio_down(monkeypatch, tmp_path):
    from paperclip_rag.lm_studio import LMStudioUnavailable

    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    rag = _FakeRAG()
    factory = _FakeFactory(rag)
    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(side_effect=LMStudioUnavailable("boom"))
    app = build_app(
        settings=Settings(),
        factory=factory,  # type: ignore[arg-type]
        lm_client=lm_client,  # type: ignore[arg-type]
    )
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "lm_studio_down"
