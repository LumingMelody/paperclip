import pytest

from paperclip_rag.ingest.refund_comments import (
    DEFAULT_LIMIT,
    DEFAULT_PER_GROUP,
    _fetch_rows,
    account_to_shop,
    build_docs,
    filter_new,
    main,
)


def test_account_to_shop_maps_amazon_account():
    assert account_to_shop("AmazonEPUS") == "EP-US"
    assert account_to_shop("AmazonEPUK") == "EP-UK"
    assert account_to_shop("AmazonEPDE") == "EP-DE"
    assert account_to_shop("AmazonPZUS") == "PZ-US"
    assert account_to_shop("AmazonDAMACA") == "DAMA-CA"


def test_account_to_shop_rejects_unknown_format():
    for bad in ("EverPretty-US", "AmazonEP", "AmazonEPUSA", "AmazonEPus",
                "AmazonXXUS", "EP-US", "EPSITEUS"):
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


class _FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.execute_calls = []

    def execute(self, sql, params):
        self.execute_calls.append((sql, params))

    def fetchall(self):
        return self.rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class _FakeConn:
    def __init__(self, rows=None):
        self.cursor_obj = _FakeCursor(rows or [])
        self.closed = False

    def cursor(self):
        return self.cursor_obj

    def close(self):
        self.closed = True


def test_fetch_rows_uses_windowed_per_group_sampling_and_sku_prefix():
    rows = [{"sellerSku": "EG123", "customerComment": "too small"}]
    conn = _FakeConn(rows)

    result = _fetch_rows(
        conn,
        account="AmazonEPUS",
        since="2026-01-01",
        sku_prefix="EG",
        per_group=3,
        limit=100,
    )

    assert result == rows
    sql, params = conn.cursor_obj.execute_calls[0]
    normalized = " ".join(sql.split())
    assert "ROW_NUMBER() OVER" in normalized
    assert "PARTITION BY r.sku_left7, r.returnReason" in normalized
    assert "ORDER BY r.check_date DESC" in normalized
    assert "WHERE d.Account = %(account)s" in normalized
    assert "AND r.check_date >= %(since)s" in normalized
    assert "AND r.customer_comments IS NOT NULL" in normalized
    assert "AND r.customer_comments != ''" in normalized
    assert "AND r.seller_sku LIKE %(sku_prefix)s" in normalized
    assert "WHERE sampled.rk <= %(per_group)s" in normalized
    assert "LIMIT %(limit)s" in normalized
    assert params == {
        "account": "AmazonEPUS",
        "since": "2026-01-01",
        "sku_prefix": "EG%",
        "per_group": 3,
        "limit": 100,
    }


def test_main_defaults_to_per_group_sampling_with_large_hard_limit(monkeypatch):
    conn = _FakeConn()
    captured = {}

    def fake_fetch(conn, account, since, sku_prefix, per_group, limit):
        captured.update({
            "account": account,
            "since": since,
            "sku_prefix": sku_prefix,
            "per_group": per_group,
            "limit": limit,
        })
        return []

    monkeypatch.setattr("paperclip_rag.ingest.refund_comments._connect", lambda: conn)
    monkeypatch.setattr("paperclip_rag.ingest.refund_comments._fetch_rows", fake_fetch)

    rc = main(["--since", "2026-01-01", "--account", "AmazonEPUS"])

    assert rc == 0
    assert captured == {
        "account": "AmazonEPUS",
        "since": "2026-01-01",
        "sku_prefix": None,
        "per_group": DEFAULT_PER_GROUP,
        "limit": DEFAULT_LIMIT,
    }
    assert conn.closed is True


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
