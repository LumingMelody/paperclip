from pathlib import Path
from unittest.mock import MagicMock

from paperclip_rag.ingest import refund_comments_all as orch
from paperclip_rag.ingest.refund_comments import DEFAULT_LIMIT, DEFAULT_PER_GROUP


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
    fetch_calls = []

    def fake_fetch(conn, account, since, sku_prefix, per_group, limit):
        fetch_calls.append((account, per_group, limit))
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
        per_group=7,
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
    assert fetch_calls == [
        ("AmazonEPUS", 7, 500),
        ("AmazonEPUK", 7, 500),
        ("AmazonEPDE", 7, 500),
    ]
    assert posted == [("refund_comments_v2", 1), ("refund_comments_v2", 1)]
    assert recorded == [1, 1]  # record_manifest fired for US and DE, not UK


def test_run_accounts_dry_run_does_not_post(monkeypatch):
    monkeypatch.setattr(
        orch, "_fetch_rows",
        lambda conn, account, since, sku_prefix, per_group, limit: [
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
        per_group=8,
        limit=500,
        collection="refund_comments_v2",
        api_base="http://x",
        manifest=manifest,
        dry_run=True,
        force=False,
    )
    assert summary[0]["status"] == "dry-run"


def test_main_passes_per_group_and_default_hard_limit(monkeypatch):
    conn = MagicMock()
    monkeypatch.setattr(orch, "_connect", lambda: conn)
    monkeypatch.setattr(orch, "discover_accounts", lambda conn, pattern: ["AmazonEPUS"])

    settings = MagicMock()
    settings.collection_dir.return_value = Path("/tmp/refund-comments")
    monkeypatch.setattr(orch, "get_settings", lambda: settings)
    monkeypatch.setattr(orch, "IngestManifest", lambda path: MagicMock())

    captured = {}

    def fake_run_accounts(**kwargs):
        captured.update(kwargs)
        return [{"account": "AmazonEPUS", "rows": 0, "new_docs": 0, "status": "ok"}]

    monkeypatch.setattr(orch, "run_accounts", fake_run_accounts)

    rc = orch.main([
        "--since",
        "2026-01-01",
        "--per-group",
        "5",
    ])

    assert rc == 0
    assert captured["per_group"] == 5
    assert captured["limit"] == DEFAULT_LIMIT
    assert captured["accounts"] == ["AmazonEPUS"]
    conn.close.assert_called_once()
    settings.collection_dir.assert_called_once_with("refund_comments_v2")


def test_main_uses_default_per_group(monkeypatch):
    conn = MagicMock()
    monkeypatch.setattr(orch, "_connect", lambda: conn)
    monkeypatch.setattr(orch, "discover_accounts", lambda conn, pattern: ["AmazonEPUS"])
    settings = MagicMock()
    settings.collection_dir.return_value = Path("/tmp/refund-comments")
    monkeypatch.setattr(orch, "get_settings", lambda: settings)
    monkeypatch.setattr(orch, "IngestManifest", lambda path: MagicMock())

    captured = {}
    monkeypatch.setattr(
        orch,
        "run_accounts",
        lambda **kwargs: captured.update(kwargs)
        or [{"account": "AmazonEPUS", "rows": 0, "new_docs": 0, "status": "ok"}],
    )

    rc = orch.main(["--since", "2026-01-01"])

    assert rc == 0
    assert captured["per_group"] == DEFAULT_PER_GROUP
