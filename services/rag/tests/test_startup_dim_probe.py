from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
from fastapi.testclient import TestClient

from paperclip_rag.api import build_app
from paperclip_rag.config import Settings


@pytest.fixture
def factory_mock():
    class _F:
        async def get(self, c): raise AssertionError("should not be called")
        def cached_collections(self): return []
    return _F()


def test_dim_probe_rejects_mismatch(monkeypatch, tmp_path, factory_mock):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    monkeypatch.setenv("PAPERCLIP_RAG_EMBEDDING_DIM", "1024")
    settings = Settings()

    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(return_value="up")
    # Probe returns 768-dim vec, settings says 1024 → must error
    lm_client.embed = AsyncMock(return_value=np.zeros((1, 768), dtype=np.float32))

    app = build_app(settings=settings, factory=factory_mock, lm_client=lm_client)
    with pytest.raises(RuntimeError, match="embedding dim mismatch"):
        with TestClient(app) as _:
            pass


def test_dim_probe_passes_match(monkeypatch, tmp_path, factory_mock):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    monkeypatch.setenv("PAPERCLIP_RAG_EMBEDDING_DIM", "1024")
    settings = Settings()

    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(return_value="up")
    lm_client.embed = AsyncMock(return_value=np.zeros((1, 1024), dtype=np.float32))

    app = build_app(settings=settings, factory=factory_mock, lm_client=lm_client)
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 200


def test_dim_probe_skipped_when_lm_studio_down(monkeypatch, tmp_path, factory_mock):
    """If LM Studio is unreachable at startup, service still starts but logs warning.
    Reasoning: we shouldn't crash dev workflows just because LM Studio is paused.
    """
    from paperclip_rag.lm_studio import LMStudioUnavailable

    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    settings = Settings()

    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(side_effect=LMStudioUnavailable("down"))
    lm_client.embed = AsyncMock(side_effect=LMStudioUnavailable("down"))

    app = build_app(settings=settings, factory=factory_mock, lm_client=lm_client)
    # Should NOT raise — startup proceeds even though LM is down
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 503  # /healthz reports the outage, startup didn't crash
