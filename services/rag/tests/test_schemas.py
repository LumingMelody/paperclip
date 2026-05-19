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


def test_search_chunk_accepts_new_lightrag_fields():
    from paperclip_rag.schemas import SearchChunk
    c = SearchChunk(
        id="c1", text="hi",
        file_path="refund_comments/EE.json",
        reference_id="ref-1",
    )
    assert c.file_path == "refund_comments/EE.json"
    assert c.reference_id == "ref-1"
    # Backward compat: minimal construction still works
    c2 = SearchChunk(id="c2", text="hi2")
    assert c2.file_path is None
    assert c2.reference_id is None


def test_kg_entity_accepts_new_lightrag_fields():
    from paperclip_rag.schemas import KGEntity
    e = KGEntity(
        name="EE02968", type="SKU",
        source_id="c1", file_path="x.json", reference_id="ref-1",
    )
    assert e.source_id == "c1"
    assert e.file_path == "x.json"
    assert e.reference_id == "ref-1"
    # Backward compat
    e2 = KGEntity(name="x")
    assert e2.source_id is None


def test_kg_relation_accepts_new_lightrag_fields():
    from paperclip_rag.schemas import KGRelation
    r = KGRelation(
        src="A", tgt="B",
        keywords="size,fit", weight=0.85,
        source_id="c1", file_path="x.json", reference_id="ref-1",
    )
    assert r.keywords == "size,fit"
    assert r.weight == 0.85
    assert r.source_id == "c1"
    # Backward compat
    r2 = KGRelation(src="A", tgt="B")
    assert r2.weight is None


def test_search_reference_model():
    from paperclip_rag.schemas import SearchReference
    ref = SearchReference(reference_id="ref-1", file_path="refund_comments/EE.json")
    assert ref.reference_id == "ref-1"
    assert ref.file_path == "refund_comments/EE.json"


def test_search_response_references_field_defaults_empty():
    from paperclip_rag.schemas import SearchResponse
    r = SearchResponse(answer="hi")
    assert r.references == []


def test_search_response_references_roundtrip():
    from paperclip_rag.schemas import SearchResponse, SearchReference
    r = SearchResponse(
        answer="x",
        references=[
            SearchReference(reference_id="ref-1", file_path="a.json"),
            SearchReference(reference_id="ref-2", file_path="b.json"),
        ],
    )
    assert len(r.references) == 2
    assert r.references[0].reference_id == "ref-1"
