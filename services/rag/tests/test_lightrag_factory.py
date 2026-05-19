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

        async def initialize_storages(self):
            return None

    with patch("paperclip_rag.lightrag_factory.LightRAG", _FakeLightRAG), \
         patch("lightrag.kg.shared_storage.initialize_pipeline_status", AsyncMock()):
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

        async def initialize_storages(self):
            return None

    with patch("paperclip_rag.lightrag_factory.LightRAG", _FakeLightRAG), \
         patch("lightrag.kg.shared_storage.initialize_pipeline_status", AsyncMock()):
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

        async def initialize_storages(self):
            return None

    with patch("paperclip_rag.lightrag_factory.LightRAG", _FakeLightRAG), \
         patch("lightrag.kg.shared_storage.initialize_pipeline_status", AsyncMock()):
        factory = LightRAGFactory(settings=settings, client=client)
        a1 = await factory.get("decisions")
        a2 = await factory.get("decisions")
        b = await factory.get("refund_comments")

    assert a1 is a2
    assert a1 is not b
    assert factory.cached_collections() == ["decisions", "refund_comments"]


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
