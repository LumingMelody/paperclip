import pytest

from paperclip_rag.ingest.refund_comments import (
    account_to_shop,
    build_docs,
    filter_new,
)


def test_account_to_shop_strips_everpretty_prefix():
    assert account_to_shop("EverPretty-US") == "EP-US"
    assert account_to_shop("EverPretty-UK") == "EP-UK"
    assert account_to_shop("EverPretty-DE") == "EP-DE"


def test_account_to_shop_rejects_unknown_format():
    for bad in ("AmazonEPUS", "EverPretty-", "EverPretty-USA", "EverPretty-us", "EP-US"):
        with pytest.raises(ValueError):
            account_to_shop(bad)


def test_build_docs_sets_shop_prefixed_id_and_file_path():
    rows = [{
        "customerComment": "dress runs small",
        "sellerSku": "EE02968",
        "styleCode": "EE02968",
        "size": "M",
        "color": "Red",
        "returnReason": "TOO_SMALL",
        "quantity": 1,
        "orderId": "302-111-222",
    }]
    docs = build_docs(rows, "EP-UK")
    assert len(docs) == 1
    d = docs[0]
    assert d["id"] == "EP-UK::302-111-222::EE02968"
    assert d["file_path"] == "EP-UK/EE02968/302-111-222"
    assert d["metadata"]["shop"] == "EP-UK"
    assert d["metadata"]["sellerSku"] == "EE02968"
    assert "_sha" in d["metadata"]
    assert d["text"].startswith("customer_comment: dress runs small")


def test_build_docs_fills_unknown_for_missing_order_and_sku():
    rows = [{"customerComment": "no ids on this row"}]
    docs = build_docs(rows, "EP-FR")
    assert docs[0]["file_path"] == "EP-FR/unknown/unknown"
    assert docs[0]["id"].startswith("EP-FR::")


class _FakeManifest:
    def __init__(self, seen_pairs):
        self._seen = set(seen_pairs)

    def seen(self, source_id, content_sha256):
        return (source_id, content_sha256) in self._seen


def test_filter_new_drops_manifest_seen_and_dup_ids():
    docs = [
        {"id": "EP-UK::a::s1", "text": "t1", "file_path": "fp1",
         "metadata": {"_sha": "sha1"}},
        {"id": "EP-UK::a::s1", "text": "t1", "file_path": "fp1",
         "metadata": {"_sha": "sha1"}},  # within-batch dup id
        {"id": "EP-UK::b::s2", "text": "t2", "file_path": "fp2",
         "metadata": {"_sha": "sha2"}},
    ]
    manifest = _FakeManifest({("EP-UK::b::s2", "sha2")})  # b already ingested
    kept, skipped, deduped = filter_new(docs, manifest, force=False)
    assert [d["id"] for d in kept] == ["EP-UK::a::s1"]
    assert skipped == 1
    assert deduped == 1


def test_filter_new_force_bypasses_manifest():
    docs = [{"id": "EP-UK::b::s2", "text": "t2", "file_path": "fp2",
             "metadata": {"_sha": "sha2"}}]
    manifest = _FakeManifest({("EP-UK::b::s2", "sha2")})
    kept, skipped, deduped = filter_new(docs, manifest, force=True)
    assert [d["id"] for d in kept] == ["EP-UK::b::s2"]
    assert skipped == 0
