import pytest

from paperclip_rag.ingest.refund_comments import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_LIMIT,
    DEFAULT_PER_GROUP,
    _fetch_rows,
    account_to_shop,
    build_docs,
    filter_new,
    main,
    post_docs,
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


class _FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def _docs(n):
    return [
        {"id": f"d{i}", "text": f"text {i}", "file_path": f"fp{i}",
         "metadata": {"_sha": f"sha{i}"}}
        for i in range(n)
    ]


def test_post_docs_sends_serial_batches_and_runs_success_callback(monkeypatch):
    responses = [
        _FakeResponse(200, {"indexed": 2}),
        _FakeResponse(200, {"indexed": 2}),
        _FakeResponse(200, {"indexed": 1}),
    ]
    calls = []
    timeouts = []

    class FakeClient:
        def __init__(self, timeout):
            timeouts.append(timeout)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url, json):
            calls.append((url, json))
            return responses.pop(0)

    monkeypatch.setattr("paperclip_rag.ingest.refund_comments.httpx.Client", FakeClient)

    callback_batches = []
    docs = _docs(5)
    result = post_docs(
        "http://rag",
        "refund_comments",
        docs,
        timeout=123,
        batch_size=2,
        on_batch_success=lambda batch: callback_batches.append([d["id"] for d in batch]),
    )

    assert timeouts == [123]
    assert [len(call[1]["docs"]) for call in calls] == [2, 2, 1]
    assert [call[0] for call in calls] == ["http://rag/index"] * 3
    assert all(call[1]["collection"] == "refund_comments" for call in calls)
    assert all(call[1]["upsert"] is True for call in calls)
    assert callback_batches == [["d0", "d1"], ["d2", "d3"], ["d4"]]
    assert result == {"indexed": 5, "batches": 3}


def test_post_docs_raises_on_failed_batch_after_recording_prior_success(monkeypatch):
    responses = [
        _FakeResponse(200, {"indexed": 2}),
        _FakeResponse(500, {"indexed": 0}, "boom"),
        _FakeResponse(200, {"indexed": 1}),
    ]
    calls = []

    class FakeClient:
        def __init__(self, timeout):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url, json):
            calls.append(json)
            return responses.pop(0)

    monkeypatch.setattr("paperclip_rag.ingest.refund_comments.httpx.Client", FakeClient)

    callback_batches = []
    with pytest.raises(RuntimeError, match="ingest failed: 500 boom"):
        post_docs(
            "http://rag",
            "refund_comments",
            _docs(5),
            batch_size=2,
            on_batch_success=lambda batch: callback_batches.append(
                [d["id"] for d in batch]
            ),
        )

    assert [len(call["docs"]) for call in calls] == [2, 2]
    assert callback_batches == [["d0", "d1"]]


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


def test_main_passes_batch_size_to_post_and_records_callback(monkeypatch, tmp_path):
    conn = _FakeConn()
    monkeypatch.setattr("paperclip_rag.ingest.refund_comments._connect", lambda: conn)
    monkeypatch.setattr(
        "paperclip_rag.ingest.refund_comments._fetch_rows",
        lambda conn, account, since, sku_prefix, per_group, limit: [
            {"customerComment": "c1", "sellerSku": "S1", "orderId": "o1"},
            {"customerComment": "c2", "sellerSku": "S2", "orderId": "o2"},
        ],
    )

    class FakeSettings:
        def collection_dir(self, collection):
            return tmp_path / collection

    class FakeManifest:
        def __init__(self, path):
            self.path = path
            self.records = []

        def seen(self, source_id, content_sha256):
            return False

        def record(self, source_id, content_sha256, chunk_count):
            self.records.append((source_id, content_sha256, chunk_count))

    manifest = FakeManifest(tmp_path / "manifest")
    monkeypatch.setattr("paperclip_rag.ingest.refund_comments.get_settings", FakeSettings)
    monkeypatch.setattr(
        "paperclip_rag.ingest.refund_comments.IngestManifest",
        lambda path: manifest,
    )

    captured = {}

    def fake_post(api_base, collection, docs, timeout=14400.0, batch_size=DEFAULT_BATCH_SIZE,
                  on_batch_success=None):
        captured.update({
            "api_base": api_base,
            "collection": collection,
            "batch_size": batch_size,
            "doc_count": len(docs),
        })
        on_batch_success(docs)
        return {"indexed": len(docs), "batches": 1}

    monkeypatch.setattr("paperclip_rag.ingest.refund_comments.post_docs", fake_post)

    rc = main([
        "--since",
        "2026-01-01",
        "--account",
        "AmazonEPUS",
        "--collection",
        "refund_comments",
        "--batch-size",
        "7",
    ])

    assert rc == 0
    assert captured == {
        "api_base": "http://127.0.0.1:9001",
        "collection": "refund_comments",
        "batch_size": 7,
        "doc_count": 2,
    }
    assert [record[0] for record in manifest.records] == [
        "EP-US::o1::S1",
        "EP-US::o2::S2",
    ]


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
