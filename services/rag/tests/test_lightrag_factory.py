"""Smoke test: factory closures forward LightRAG-shaped kwargs to LMStudioClient."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from paperclip_rag.config import Settings
from paperclip_rag.lightrag_factory import LightRAGFactory


@pytest.mark.asyncio
async def test_llm_closure_translates_history_messages_to_history(monkeypatch, tmp_path):
    """LightRAG calls llm_model_func(prompt, system_prompt, history_messages, ...).
    Our closure must forward `history_messages` to LMStudioClient.chat as `history`.
    """
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    settings = Settings()

    client = MagicMock()
    client.chat = AsyncMock(return_value="ok")
    client.embed = AsyncMock(return_value=np.zeros((1, 768), dtype=np.float32))

    # Avoid actually constructing a LightRAG (it does disk IO). Patch the
    # LightRAG class inside the factory module to a sentinel that records its kwargs.
    captured: dict = {}

    class _FakeLightRAG:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    with patch("paperclip_rag.lightrag_factory.LightRAG", _FakeLightRAG):
        factory = LightRAGFactory(settings=settings, client=client)
        await factory.get("decisions")

    # Exercise the LLM closure exactly the way LightRAG will:
    llm_fn = captured["llm_model_func"]
    await llm_fn("the prompt", system_prompt="sys", history_messages=[{"role": "user", "content": "h"}])

    client.chat.assert_awaited_once_with(
        prompt="the prompt",
        system_prompt="sys",
        history=[{"role": "user", "content": "h"}],
    )


@pytest.mark.asyncio
async def test_embed_closure_forwards_texts(monkeypatch, tmp_path):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    settings = Settings()

    client = MagicMock()
    client.chat = AsyncMock(return_value="ok")
    client.embed = AsyncMock(return_value=np.zeros((2, 768), dtype=np.float32))

    captured: dict = {}

    class _FakeLightRAG:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    with patch("paperclip_rag.lightrag_factory.LightRAG", _FakeLightRAG):
        factory = LightRAGFactory(settings=settings, client=client)
        await factory.get("decisions")

    embed_fn = captured["embedding_func"].func
    result = await embed_fn(["a", "b"])

    client.embed.assert_awaited_once_with(["a", "b"])
    assert result.shape == (2, 768)


@pytest.mark.asyncio
async def test_get_caches_and_isolates_collections(monkeypatch, tmp_path):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    settings = Settings()
    client = MagicMock()

    class _FakeLightRAG:
        def __init__(self, **_):
            pass

    with patch("paperclip_rag.lightrag_factory.LightRAG", _FakeLightRAG):
        factory = LightRAGFactory(settings=settings, client=client)
        a1 = await factory.get("decisions")
        a2 = await factory.get("decisions")
        b = await factory.get("refund_comments")

    assert a1 is a2
    assert a1 is not b
    assert factory.cached_collections() == ["decisions", "refund_comments"]
