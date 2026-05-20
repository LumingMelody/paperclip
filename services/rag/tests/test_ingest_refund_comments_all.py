from unittest.mock import MagicMock

from paperclip_rag.ingest import refund_comments_all as orch


def test_discover_accounts_filters_by_pattern():
    cur = MagicMock()
    cur.fetchall.return_value = [
        {"Account": "AmazonEPUS"},
        {"Account": "AmazonEPUK"},
        {"Account": "AmazonEPDE"},
    ]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    accounts = orch.discover_accounts(conn, pattern="AmazonEP%")
    assert accounts == ["AmazonEPUS", "AmazonEPUK", "AmazonEPDE"]
    sql, params = cur.execute.call_args[0]
    assert "DISTINCT Account" in sql
    assert params["pat"] == "AmazonEP%"


def test_run_accounts_isolates_a_failing_account(monkeypatch):
    # EP-UK fetch raises; EP-US and EP-DE must still succeed.
    def fake_fetch(conn, account, since, sku_prefix, limit):
        if account == "AmazonEPUK":
            raise RuntimeError("DWS timeout")
        return [{"customerComment": "c", "sellerSku": "S1", "orderId": "o1"}]

    posted: list[tuple[str, int]] = []

    def fake_post(api_base, collection, docs, timeout=14400.0):
        posted.append((collection, len(docs)))
        return {"indexed": len(docs)}

    monkeypatch.setattr(orch, "_fetch_rows", fake_fetch)
    monkeypatch.setattr(orch, "post_docs", fake_post)
    recorded: list[int] = []
    monkeypatch.setattr(
        orch, "record_manifest",
        lambda manifest, docs: recorded.append(len(docs)),
    )

    manifest = MagicMock()
    manifest.seen.return_value = False

    summary = orch.run_accounts(
        conn=MagicMock(),
        accounts=["AmazonEPUS", "AmazonEPUK", "AmazonEPDE"],
        since="2026-01-01",
        limit=500,
        collection="refund_comments_v2",
        api_base="http://x",
        manifest=manifest,
        dry_run=False,
        force=False,
    )

    status = {s["account"]: s["status"] for s in summary}
    assert status["AmazonEPUS"] == "ok"
    assert status["AmazonEPDE"] == "ok"
    assert status["AmazonEPUK"].startswith("FAILED")
    assert posted == [("refund_comments_v2", 1), ("refund_comments_v2", 1)]
    assert recorded == [1, 1]  # record_manifest fired for US and DE, not UK


def test_run_accounts_dry_run_does_not_post(monkeypatch):
    monkeypatch.setattr(
        orch, "_fetch_rows",
        lambda conn, account, since, sku_prefix, limit: [
            {"customerComment": "c", "sellerSku": "S1", "orderId": "o1"}
        ],
    )

    def fail_post(*a, **k):
        raise AssertionError("post_docs must not be called in dry-run")

    monkeypatch.setattr(orch, "post_docs", fail_post)
    manifest = MagicMock()
    manifest.seen.return_value = False

    summary = orch.run_accounts(
        conn=MagicMock(),
        accounts=["AmazonEPUS"],
        since="2026-01-01",
        limit=500,
        collection="refund_comments_v2",
        api_base="http://x",
        manifest=manifest,
        dry_run=True,
        force=False,
    )
    assert summary[0]["status"] == "dry-run"
