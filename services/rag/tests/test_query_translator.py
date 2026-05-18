import pytest
from paperclip_rag.query_translator import contains_cjk


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
