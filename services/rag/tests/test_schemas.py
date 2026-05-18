import pytest
from pydantic import ValidationError

from paperclip_rag.schemas import (
    IndexDoc,
    IndexRequest,
    SearchMeta,
    SearchMode,
    SearchRequest,
    SearchResponse,
)


def test_index_doc_requires_id_and_text():
    with pytest.raises(ValidationError):
        IndexDoc(text="hi")  # missing id
    with pytest.raises(ValidationError):
        IndexDoc(id="d1")  # missing text
    d = IndexDoc(id="d1", text="hi", metadata={"k": "v"})
    assert d.metadata == {"k": "v"}


def test_index_request_default_upsert():
    req = IndexRequest(
        collection="decisions",
        docs=[IndexDoc(id="a", text="x")],
    )
    assert req.upsert is True


def test_search_mode_enum():
    assert SearchMode("hybrid") is SearchMode.HYBRID
    with pytest.raises(ValueError):
        SearchMode("bogus")


def test_search_request_defaults():
    req = SearchRequest(collection="decisions", query="why?")
    assert req.mode is SearchMode.HYBRID
    assert req.top_k == 10


def test_search_top_k_bounds():
    with pytest.raises(ValidationError):
        SearchRequest(collection="x", query="q", top_k=0)
    with pytest.raises(ValidationError):
        SearchRequest(collection="x", query="q", top_k=101)


def test_search_request_translate_default_auto():
    req = SearchRequest(collection="x", query="hi")
    assert req.translate == "auto"


def test_search_request_translate_off():
    req = SearchRequest(collection="x", query="hi", translate="off")
    assert req.translate == "off"


def test_search_request_translate_invalid_value():
    with pytest.raises(ValidationError):
        SearchRequest(collection="x", query="hi", translate="bogus")


def test_search_response_meta_optional():
    r = SearchResponse(answer="ok")
    assert r.meta is None


def test_search_response_meta_roundtrip():
    meta = SearchMeta(
        translation="translated",
        original_query="退货",
        translated_query="return",
        translate_ms=312,
    )
    r = SearchResponse(answer="ok", meta=meta)
    assert r.meta.translation == "translated"
    assert r.meta.translate_ms == 312
