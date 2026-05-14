"""Ingest refund_comments from MySQL into the `refund_comments` LightRAG collection.

Schema source: packages/tool-registry/src/tools/dws/_query.py::refund_comments

For each row, build a single text body from `customerComment` plus structured
context (SKU, size, color, return reason). Use the orderId + sellerSku as
source_id; sha256 of the comment body as content hash for manifest idempotency.

Usage:
    uv run python -m paperclip_rag.ingest.refund_comments \\
        --since 2026-01-01 \\
        --limit 500 \\
        [--sku-prefix EG] \\
        [--account ACCOUNT_ID]      # else read PAPERCLIP_RAG_INGEST_ACCOUNT
        [--api-base http://127.0.0.1:9001] \\
        [--collection refund_comments] \\
        [--dry-run] \\
        [--force]                    # bypass manifest skip
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterator

import httpx
import pymysql
from loguru import logger
from pymysql.cursors import DictCursor

from ..config import get_settings
from ..manifest import IngestManifest


_REQUIRED_ENV = ("DWS_DB_HOST", "DWS_DB_USER", "DWS_DB_PASSWORD", "DWS_DB_DATABASE")


def _connect() -> pymysql.Connection:
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        raise RuntimeError(f"missing env vars: {', '.join(missing)}")
    return pymysql.connect(
        host=os.environ["DWS_DB_HOST"],
        port=int(os.environ.get("DWS_DB_PORT") or "3306"),
        user=os.environ["DWS_DB_USER"],
        password=os.environ["DWS_DB_PASSWORD"],
        database=os.environ["DWS_DB_DATABASE"],
        charset="utf8mb4",
        connect_timeout=8,
        cursorclass=DictCursor,
    )


def _fetch_rows(
    conn: pymysql.Connection,
    account: str,
    since: str,
    sku_prefix: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    sql = """
        SELECT
            r.check_date AS eventDate,
            r.seller_sku AS sellerSku,
            r.sku_left7 AS styleCode,
            r.size,
            r.color,
            r.returnReason,
            r.customer_comments AS customerComment,
            r.quantity,
            r.rf_quantity AS refundQuantity,
            r.amazon_order_id AS orderId
        FROM dws_od_amazon_refund_rate_d r
        INNER JOIN dm_allretrun_analysis_d d
            ON r.amazon_order_id = d.orderid
        WHERE d.Account = %(account)s
          AND r.check_date >= %(since)s
          AND r.customer_comments IS NOT NULL
          AND r.customer_comments != ''
    """
    params: dict[str, Any] = {"account": account, "since": since}
    if sku_prefix:
        sql += " AND r.seller_sku LIKE %(sku_prefix)s"
        params["sku_prefix"] = f"{sku_prefix}%"
    sql += " ORDER BY r.check_date DESC LIMIT %(limit)s"
    params["limit"] = limit
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def _row_to_text(r: dict[str, Any]) -> str:
    """Build a single-paragraph text body from a refund comment row.

    Each row becomes a self-contained chunk: customer comment + structured
    context. Keep concise — LightRAG chunking will split if needed.
    """
    parts = [f"customer_comment: {r.get('customerComment', '').strip()}"]
    for k in ("sellerSku", "styleCode", "size", "color", "returnReason"):
        v = r.get(k)
        if v is None or v == "":
            continue
        parts.append(f"{k}: {v}")
    if r.get("quantity") is not None:
        parts.append(f"quantity: {r['quantity']}")
    return "\n".join(parts)


def _row_id(r: dict[str, Any]) -> str:
    """Source ID = order_id + seller_sku, stable across re-runs."""
    oid = str(r.get("orderId") or "")
    sku = str(r.get("sellerSku") or "")
    return f"{oid}::{sku}" if oid or sku else f"row:{hash(json.dumps(r, default=str)) & 0xFFFFFFFF:x}"


def _content_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="ISO date, e.g. 2026-01-01")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--sku-prefix", default=None)
    parser.add_argument("--account", default=os.environ.get("PAPERCLIP_RAG_INGEST_ACCOUNT"))
    parser.add_argument("--api-base", default="http://127.0.0.1:9001")
    parser.add_argument("--collection", default="refund_comments")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="bypass manifest skip")
    args = parser.parse_args(argv)

    if not args.account:
        logger.error("--account is required (or set PAPERCLIP_RAG_INGEST_ACCOUNT)")
        return 2

    logger.info("connecting to MySQL")
    try:
        conn = _connect()
    except Exception as e:
        logger.error("DB connect failed: {}", e)
        return 2

    try:
        rows = _fetch_rows(
            conn,
            account=args.account,
            since=args.since,
            sku_prefix=args.sku_prefix,
            limit=args.limit,
        )
    finally:
        conn.close()

    logger.info("fetched {} rows", len(rows))
    if not rows:
        return 0

    settings = get_settings()
    manifest_path = settings.collection_dir(args.collection) / "_manifest.jsonl"
    manifest = IngestManifest(manifest_path)

    docs = []
    skipped = 0
    for r in rows:
        text = _row_to_text(r)
        sid = _row_id(r)
        sha = _content_sha(text)
        if not args.force and manifest.seen(sid, sha):
            skipped += 1
            continue
        docs.append({
            "id": sid,
            "text": text,
            "metadata": {
                "source": "dws_od_amazon_refund_rate_d",
                "sellerSku": r.get("sellerSku"),
                "styleCode": r.get("styleCode"),
                "eventDate": str(r.get("eventDate") or ""),
                "returnReason": r.get("returnReason"),
                "orderId": r.get("orderId"),
                "_sha": sha,
            },
        })

    logger.info("after manifest filter: {} new docs, {} skipped", len(docs), skipped)

    if args.dry_run:
        for d in docs[:3]:
            print(json.dumps(d, ensure_ascii=False, default=str))
        print(f"... total new: {len(docs)} (skipped {skipped})")
        return 0

    if not docs:
        logger.info("nothing to ingest")
        return 0

    payload = {"collection": args.collection, "docs": docs, "upsert": True}
    logger.info("POSTing {} docs to {}/index", len(docs), args.api_base)
    with httpx.Client(timeout=3600.0) as client:
        r = client.post(f"{args.api_base}/index", json=payload)
    if r.status_code >= 300:
        logger.error("ingest failed: {} {}", r.status_code, r.text)
        return 1

    # Manifest write only on success
    for d in docs:
        manifest.record(d["id"], d["metadata"]["_sha"], chunk_count=1)
    logger.info("ingested: {}", r.json())
    return 0


if __name__ == "__main__":
    sys.exit(main())
