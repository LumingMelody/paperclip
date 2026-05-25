"""Multi-account ingest orchestrator for the `refund_comments` collection.

Discovers every AmazonEP* account in dws `dm_allretrun_analysis_d`, then
runs the single-account ingest logic (from refund_comments.py) for each one,
writing all docs into ONE shared collection. A single account's failure is
logged and skipped — the run continues.

Usage:
    uv run python -m paperclip_rag.ingest.refund_comments_all \\
        --since 2026-01-01 \\
        [--per-group 8] \\              # rows per sku/reason group
        [--limit 100000] \\             # per-account hard cap
        [--collection refund_comments_v2] \\
        [--account-pattern 'AmazonEP%'] \\
        [--api-base http://127.0.0.1:9001] \\
        [--batch-size 300] \\
        [--dry-run] \\
        [--force]
"""
from __future__ import annotations

import argparse
import sys
from typing import Any

from loguru import logger

from ..config import get_settings
from ..manifest import IngestManifest
from .refund_comments import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_LIMIT,
    DEFAULT_PER_GROUP,
    _connect,
    _fetch_rows,
    account_to_shop,
    build_docs,
    filter_new,
    post_docs,
    record_manifest,
)


def discover_accounts(conn: Any, pattern: str = "AmazonEP%") -> list[str]:
    """Return distinct Account values matching `pattern`, sorted."""
    sql = (
        "SELECT DISTINCT Account FROM dm_allretrun_analysis_d "
        "WHERE Account LIKE %(pat)s ORDER BY Account"
    )
    with conn.cursor() as cur:
        cur.execute(sql, {"pat": pattern})
        return [row["Account"] for row in cur.fetchall()]


def run_accounts(
    conn: Any,
    accounts: list[str],
    since: str,
    per_group: int,
    limit: int,
    collection: str,
    api_base: str,
    manifest: IngestManifest,
    dry_run: bool,
    force: bool,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> list[dict[str, Any]]:
    """Ingest each account into `collection`. Per-account failures are isolated.

    Returns a per-account summary list of dicts:
    {account, rows, new_docs, status}.
    """
    summary: list[dict[str, Any]] = []
    for account in accounts:
        entry: dict[str, Any] = {"account": account, "rows": 0, "new_docs": 0}
        try:
            shop = account_to_shop(account)
            rows = _fetch_rows(
                conn,
                account=account,
                since=since,
                sku_prefix=None,
                per_group=per_group,
                limit=limit,
            )
            entry["rows"] = len(rows)
            docs = build_docs(rows, shop)
            new_docs, skipped, deduped = filter_new(docs, manifest, force)
            entry["new_docs"] = len(new_docs)
            logger.info(
                "{}: {} rows -> {} new ({} skipped, {} deduped)",
                account, len(rows), len(new_docs), skipped, deduped,
            )
            if dry_run:
                entry["status"] = "dry-run"
            else:
                if new_docs:
                    post_docs(
                        api_base,
                        collection,
                        new_docs,
                        batch_size=batch_size,
                        on_batch_success=lambda batch_docs: record_manifest(
                            manifest,
                            batch_docs,
                        ),
                    )
                entry["status"] = "ok"
        except Exception as e:  # noqa: BLE001 — isolate one account's failure
            logger.error("account {} failed: {}", account, e)
            entry["status"] = f"FAILED: {e}"
        summary.append(entry)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="ISO date, e.g. 2026-01-01")
    parser.add_argument(
        "--per-group",
        type=int,
        default=DEFAULT_PER_GROUP,
        help="rows to keep per (sku_left7, returnReason) group",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help="per-account hard cap after per-group sampling",
    )
    parser.add_argument("--collection", default="refund_comments_v2")
    parser.add_argument("--account-pattern", default="AmazonEP%")
    parser.add_argument("--api-base", default="http://127.0.0.1:9001")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="docs per synchronous /index request",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="bypass manifest skip")
    args = parser.parse_args(argv)

    logger.info("connecting to MySQL")
    try:
        conn = _connect()
    except Exception as e:
        logger.error("DB connect failed: {}", e)
        return 2

    try:
        try:
            accounts = discover_accounts(conn, pattern=args.account_pattern)
        except Exception as e:
            logger.error("account discovery failed: {}", e)
            return 2
        logger.info("discovered {} accounts: {}", len(accounts), accounts)
        if not accounts:
            logger.error("no accounts matched pattern {}", args.account_pattern)
            return 2

        try:
            settings = get_settings()
            manifest_path = settings.collection_dir(args.collection) / "_manifest.jsonl"
            manifest = IngestManifest(manifest_path)
        except Exception as e:
            logger.error("manifest setup failed: {}", e)
            return 2

        summary = run_accounts(
            conn=conn,
            accounts=accounts,
            since=args.since,
            per_group=args.per_group,
            limit=args.limit,
            collection=args.collection,
            api_base=args.api_base,
            manifest=manifest,
            dry_run=args.dry_run,
            force=args.force,
            batch_size=args.batch_size,
        )
    finally:
        conn.close()

    logger.info("=== ingest summary (collection={}) ===", args.collection)
    for s in summary:
        logger.info(
            "  {:20s} rows={:5d} new={:5d} {}",
            s["account"], s["rows"], s["new_docs"], s["status"],
        )
    failed = [s for s in summary if str(s["status"]).startswith("FAILED")]
    if failed:
        logger.error("{} account(s) failed", len(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
