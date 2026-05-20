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
import re
import sys
from typing import Any

import httpx
import pymysql
from loguru import logger
from pymysql.cursors import DictCursor

from ..config import get_settings
from ..manifest import IngestManifest


_REQUIRED_ENV = ("DWS_DB_HOST", "DWS_DB_USER", "DWS_DB_PASSWORD", "DWS_DB_DATABASE")
_ACCOUNT_RE = re.compile(r"^Amazon(EP|PZ|DAMA)([A-Z]{2})$")


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


def account_to_shop(account: str) -> str:
    """`AmazonEPUS` -> `EP-US`. Inverse of tool-registry `shopToAccount`.

    Raises ValueError on any other format.
    """
    m = _ACCOUNT_RE.match(account)
    if not m:
        raise ValueError(f"account must look like AmazonEPUS, got {account!r}")
    return f"{m.group(1)}-{m.group(2)}"


def _row_id(r: dict[str, Any], shop: str) -> str:
    """Source ID = shop::order_id::seller_sku, stable across re-runs.

    The shop prefix prevents the same orderId/sku colliding across markets
    in the shared collection.
    """
    oid = str(r.get("orderId") or "")
    sku = str(r.get("sellerSku") or "")
    if not oid and not sku:
        return f"{shop}::row:{hash(json.dumps(r, default=str)) & 0xFFFFFFFF:x}"
    return f"{shop}::{oid}::{sku}"


def _row_file_path(r: dict[str, Any], shop: str) -> str:
    """file_path = shop/sku/orderId — drives LightRAG's reference list and is
    parsed back into '站点 / SKU / 订单' by the B1 tool."""
    oid = str(r.get("orderId") or "") or "unknown"
    sku = str(r.get("sellerSku") or "") or "unknown"
    return f"{shop}/{sku}/{oid}"


def _content_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def build_docs(rows: list[dict[str, Any]], shop: str) -> list[dict[str, Any]]:
    """Transform DWS refund rows into LightRAG index docs for one shop.

    Pure: no DB, no manifest, no HTTP. Manifest/dup filtering is filter_new's job.
    """
    docs: list[dict[str, Any]] = []
    for r in rows:
        text = _row_to_text(r)
        docs.append({
            "id": _row_id(r, shop),
            "text": text,
            "file_path": _row_file_path(r, shop),
            "metadata": {
                "source": "dws_od_amazon_refund_rate_d",
                "shop": shop,
                "sellerSku": r.get("sellerSku"),
                "styleCode": r.get("styleCode"),
                "eventDate": str(r.get("eventDate") or ""),
                "returnReason": r.get("returnReason"),
                "orderId": r.get("orderId"),
                "_sha": _content_sha(text),
            },
        })
    return docs


def filter_new(
    docs: list[dict[str, Any]],
    manifest: IngestManifest,
    force: bool,
) -> tuple[list[dict[str, Any]], int, int]:
    """Drop docs already in the manifest and within-batch duplicate ids.

    Returns (kept_docs, manifest_skipped, dup_id_deduped).
    """
    kept: list[dict[str, Any]] = []
    skipped = 0
    deduped = 0
    seen_ids: set[str] = set()
    for d in docs:
        sid = d["id"]
        sha = d["metadata"]["_sha"]
        if not force and manifest.seen(sid, sha):
            skipped += 1
            continue
        if sid in seen_ids:
            deduped += 1
            continue
        seen_ids.add(sid)
        kept.append(d)
    return kept, skipped, deduped


def post_docs(
    api_base: str,
    collection: str,
    docs: list[dict[str, Any]],
    timeout: float = 14400.0,
) -> dict[str, Any]:
    """POST docs to the RAG /index endpoint. Raises RuntimeError on any
    failure — HTTP >= 300 or a network/connection error.

    The 4h timeout matches synchronous LightRAG ingest of large batches —
    a premature ReadTimeout would leave the manifest unwritten.
    """
    payload = {"collection": collection, "docs": docs, "upsert": True}
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{api_base}/index", json=payload)
    except httpx.HTTPError as e:
        raise RuntimeError(f"ingest request failed: {e}") from e
    if resp.status_code >= 300:
        raise RuntimeError(f"ingest failed: {resp.status_code} {resp.text}")
    return resp.json()


def record_manifest(manifest: IngestManifest, docs: list[dict[str, Any]]) -> None:
    """Record each successfully ingested doc's id + content sha into the manifest."""
    for d in docs:
        manifest.record(d["id"], d["metadata"]["_sha"], chunk_count=1)


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
    try:
        shop = account_to_shop(args.account)
    except ValueError as e:
        logger.error("{}", e)
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

    docs = build_docs(rows, shop)
    new_docs, skipped, deduped = filter_new(docs, manifest, args.force)
    logger.info(
        "after filter: {} new docs, {} manifest-skipped, {} dup-id-deduped",
        len(new_docs), skipped, deduped,
    )

    if args.dry_run:
        for d in new_docs[:3]:
            print(json.dumps(d, ensure_ascii=False, default=str))
        print(f"... total new: {len(new_docs)} (skipped {skipped})")
        return 0

    if not new_docs:
        logger.info("nothing to ingest")
        return 0

    logger.info("POSTing {} docs to {}/index", len(new_docs), args.api_base)
    try:
        result = post_docs(args.api_base, args.collection, new_docs)
    except RuntimeError as e:
        logger.error("{}", e)
        return 1
    record_manifest(manifest, new_docs)
    logger.info("ingested: {}", result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
