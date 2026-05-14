import httpx
import numpy as np
import pytest
import respx
from httpx import Response

from paperclip_rag.lm_studio import (
    LMStudioClient,
    LMStudioUnavailable,
    ModelNotLoaded,
)


@pytest.mark.asyncio
async def test_healthcheck_ok(respx_mock):
    respx_mock.get("http://127.0.0.1:1234/v1/models").mock(
        return_value=Response(200, json={
            "data": [
                {"id": "qwen3-30b-a3b-instruct-2507"},
                {"id": "nomic-embed-text-v1.5"},
            ]
        })
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="qwen3-30b-a3b-instruct-2507",
        embedding_model="nomic-embed-text-v1.5",
    )
    assert await c.healthcheck() == "up"


@pytest.mark.asyncio
async def test_healthcheck_model_missing(respx_mock):
    respx_mock.get("http://127.0.0.1:1234/v1/models").mock(
        return_value=Response(200, json={"data": [{"id": "some-other-llm"}]})
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="qwen3-30b-a3b-instruct-2507",
        embedding_model="nomic-embed-text-v1.5",
    )
    with pytest.raises(ModelNotLoaded) as exc:
        await c.healthcheck(raise_on_missing=True)
    assert "qwen3-30b-a3b-instruct-2507" in str(exc.value)


@pytest.mark.asyncio
async def test_healthcheck_unreachable(respx_mock):
    respx_mock.get("http://127.0.0.1:1234/v1/models").mock(
        side_effect=httpx.ConnectError("boom")
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="x", embedding_model="y",
    )
    with pytest.raises(LMStudioUnavailable):
        await c.healthcheck()


@pytest.mark.asyncio
async def test_embed_batch(respx_mock):
    respx_mock.post("http://127.0.0.1:1234/v1/embeddings").mock(
        return_value=Response(200, json={
            "data": [
                {"embedding": [0.1] * 768, "index": 0},
                {"embedding": [0.2] * 768, "index": 1},
            ],
            "model": "nomic-embed-text-v1.5",
        })
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="x", embedding_model="nomic-embed-text-v1.5",
    )
    vecs = await c.embed(["a", "b"])
    assert isinstance(vecs, np.ndarray)
    assert vecs.shape == (2, 768)
    assert vecs.dtype == np.float32


@pytest.mark.asyncio
async def test_chat_returns_text(respx_mock):
    respx_mock.post("http://127.0.0.1:1234/v1/chat/completions").mock(
        return_value=Response(200, json={
            "choices": [{"message": {"role": "assistant", "content": "hi there"}}],
        })
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="qwen3-30b-a3b-instruct-2507",
        embedding_model="x",
    )
    out = await c.chat("hello")
    assert out == "hi there"


@pytest.mark.asyncio
async def test_embed_wraps_connect_error(respx_mock):
    respx_mock.post("http://127.0.0.1:1234/v1/embeddings").mock(
        side_effect=httpx.ConnectError("refused")
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="x", embedding_model="y",
    )
    with pytest.raises(LMStudioUnavailable):
        await c.embed(["hi"])


@pytest.mark.asyncio
async def test_chat_empty_choices_raises(respx_mock):
    respx_mock.post("http://127.0.0.1:1234/v1/chat/completions").mock(
        return_value=Response(200, json={"choices": []})
    )
    c = LMStudioClient(
        base_url="http://127.0.0.1:1234/v1",
        llm_model="x", embedding_model="y",
    )
    with pytest.raises(LMStudioUnavailable):
        await c.chat("hello")
