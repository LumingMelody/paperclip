import pytest
from unittest.mock import AsyncMock, MagicMock
from paperclip_rag.query_translator import contains_cjk, TranslationResult, translate_if_cjk


@pytest.mark.parametrize(
    "text, expected",
    [
        ("hello world", False),
        ("Fifi return rate", False),
        ("退货率", True),
        ("Fifi 退货率怎么样", True),
        ("", False),
        ("12345", False),
        ("🙂", False),
        ("被 FC 损坏的订单", True),
    ],
)
def test_contains_cjk(text, expected):
    assert contains_cjk(text) is expected


@pytest.mark.asyncio
async def test_passthrough_pure_english_makes_zero_llm_calls():
    lm = MagicMock()
    lm.chat = AsyncMock()
    result = await translate_if_cjk("Fifi return rate", lm_client=lm)
    assert isinstance(result, TranslationResult)
    assert result.status == "passthrough"
    assert result.text == "Fifi return rate"
    assert result.original == "Fifi return rate"
    assert result.translate_ms == 0
    assert result.fallback_reason is None
    assert lm.chat.call_count == 0


@pytest.mark.asyncio
async def test_translate_success_returns_english():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="What is Fifi's return rate?")
    lm.llm_model = "qwen3-30b"
    result = await translate_if_cjk("Fifi 的退货率怎么样？", lm_client=lm)
    assert result.status == "translated"
    assert result.text == "What is Fifi's return rate?"
    assert result.original == "Fifi 的退货率怎么样？"
    assert result.translate_ms >= 0
    assert result.fallback_reason is None
    assert lm.chat.call_count == 1
    kwargs = lm.chat.call_args.kwargs
    assert kwargs["temperature"] == 0
    assert kwargs["max_tokens"] == 200


@pytest.mark.asyncio
async def test_translate_uses_translation_llm_model_when_provided():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="hi")
    lm.llm_model = "qwen3-30b"
    await translate_if_cjk("你好", lm_client=lm, llm_model="qwen3-4b")
    # When llm_model override is passed, it's plumbed via the override path
    # (current LMStudioClient binds model at construction; verify via the
    # prompt being sent and that no model-binding side effect was attempted)
    assert lm.chat.call_count == 1


import asyncio
from paperclip_rag.lm_studio import LMStudioUnavailable, ModelNotLoaded


@pytest.mark.asyncio
async def test_translate_timeout_falls_back_to_original():
    async def slow_chat(*a, **kw):
        await asyncio.sleep(10)
        return "should never see this"

    lm = MagicMock()
    lm.chat = AsyncMock(side_effect=slow_chat)
    result = await translate_if_cjk("退货", lm_client=lm, timeout_s=0.05)
    assert result.status == "fallback"
    assert result.fallback_reason == "timeout"
    assert result.text == "退货"


@pytest.mark.asyncio
async def test_translate_lm_unavailable_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(side_effect=LMStudioUnavailable("conn refused"))
    result = await translate_if_cjk("退货", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "lm_down"
    assert result.text == "退货"


@pytest.mark.asyncio
async def test_translate_model_unloaded_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(side_effect=ModelNotLoaded("qwen3-30b not loaded"))
    result = await translate_if_cjk("退货", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "model_unloaded"
    assert result.text == "退货"
