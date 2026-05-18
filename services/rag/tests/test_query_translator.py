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
