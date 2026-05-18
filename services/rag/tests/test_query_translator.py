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
async def test_translate_forwards_llm_model_override():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="hi")
    lm.llm_model = "qwen3-30b"
    await translate_if_cjk("你好", lm_client=lm, llm_model="qwen3-4b")
    assert lm.chat.call_args.kwargs["model"] == "qwen3-4b"


@pytest.mark.asyncio
async def test_translate_omits_model_when_no_override():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="hi")
    lm.llm_model = "qwen3-30b"
    await translate_if_cjk("你好", lm_client=lm)  # no llm_model
    assert lm.chat.call_args.kwargs.get("model") is None


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


@pytest.mark.asyncio
async def test_translate_empty_output_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="   ")
    result = await translate_if_cjk("退货", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "output_check:empty"
    assert result.text == "退货"


@pytest.mark.asyncio
async def test_translate_length_anomaly_falls_back():
    short_input = "退货"  # 2 chars
    long_output = "x" * 200  # >10x
    lm = MagicMock()
    lm.chat = AsyncMock(return_value=long_output)
    result = await translate_if_cjk(short_input, lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "output_check:length"


@pytest.mark.asyncio
async def test_translate_cjk_residue_falls_back():
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="return rate 的")
    result = await translate_if_cjk("退货率", lm_client=lm)
    assert result.status == "fallback"
    assert result.fallback_reason == "output_check:cjk_residue"


@pytest.mark.asyncio
async def test_resolve_query_off_skips_translation():
    from paperclip_rag.query_translator import resolve_query
    lm = MagicMock()
    lm.chat = AsyncMock()
    result = await resolve_query("退货率", translate="off", lm_client=lm)
    assert result.status == "passthrough"
    assert result.text == "退货率"
    assert lm.chat.call_count == 0


@pytest.mark.asyncio
async def test_resolve_query_auto_translates_cjk():
    from paperclip_rag.query_translator import resolve_query
    lm = MagicMock()
    lm.chat = AsyncMock(return_value="return rate")
    result = await resolve_query("退货率", translate="auto", lm_client=lm)
    assert result.status == "translated"
    assert result.text == "return rate"
