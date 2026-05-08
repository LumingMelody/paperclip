#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from typing import Any


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps({"version": "1", **payload}, ensure_ascii=False))
    raise SystemExit(code)


try:
    import pymssql
except ImportError:
    emit(
        {"error": "UpstreamError", "message": "pymssql not available; run: uv pip install pymssql"},
        2,
    )


def serialize(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: serialize(value) for key, value in row.items()}


def read_request() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as exc:
        emit({"error": "ValidationError", "message": f"Invalid JSON request: {exc}"}, 1)
    if not isinstance(payload, dict):
        emit({"error": "ValidationError", "message": "Request must be a JSON object"}, 1)
    if payload.get("version") != "1":
        emit({"error": "ValidationError", "message": f"unsupported helper protocol version: {payload.get('version')}"}, 1)
    return payload


def connect():
    missing = [k for k in ("FBA_DB_HOST", "FBA_DB_USER", "FBA_DB_PASSWORD", "FBA_DB_DATABASE") if not os.environ.get(k)]
    if missing:
        emit({"error": "UpstreamError", "message": f"Missing database env vars: {', '.join(missing)}"}, 2)
    return pymssql.connect(
        server=os.environ["FBA_DB_HOST"],
        port=int(os.environ.get("FBA_DB_PORT") or "1433"),
        user=os.environ["FBA_DB_USER"],
        password=os.environ["FBA_DB_PASSWORD"],
        database=os.environ["FBA_DB_DATABASE"],
        login_timeout=8,
        charset="utf8",
        as_dict=True,
    )


def current_inventory(conn, store: str, sku: str | None, top: int) -> list[dict[str, Any]]:
    sql = """
        SELECT TOP %(top)s
            sku,
            asin,
            store,
            afn_fulfillable_quantity AS fulfillableQty,
            afn_total_quantity AS totalQty,
            your_price AS price,
            updated_at AS updatedAt
        FROM dbo.T_amazon_fba_inventory_current WITH(NOLOCK)
        WHERE store = %(store)s
    """
    params: dict[str, Any] = {"store": store, "top": top}
    if sku:
        sql += " AND sku LIKE %(sku_like)s"
        params["sku_like"] = f"{sku}%"
    sql += " ORDER BY afn_fulfillable_quantity DESC"
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = [serialize_row(r) for r in cur.fetchall()]
    cur.close()
    return rows


def low_stock(conn, store: str, fulfillable_lt: int, top: int) -> list[dict[str, Any]]:
    sql = """
        SELECT TOP %(top)s
            sku,
            asin,
            store,
            afn_fulfillable_quantity AS fulfillableQty,
            afn_total_quantity AS totalQty,
            your_price AS price,
            updated_at AS updatedAt
        FROM dbo.T_amazon_fba_inventory_current WITH(NOLOCK)
        WHERE store = %(store)s
          AND afn_fulfillable_quantity < %(threshold)s
        ORDER BY afn_fulfillable_quantity ASC
    """
    cur = conn.cursor()
    cur.execute(sql, {"store": store, "threshold": fulfillable_lt, "top": top})
    rows = [serialize_row(r) for r in cur.fetchall()]
    cur.close()
    return rows


def snapshot_history(conn, store: str, sku: str, days: int) -> list[dict[str, Any]]:
    sql = """
        SELECT
            CAST(report_generated_at AS DATE) AS reportDate,
            sku,
            asin,
            store,
            afn_fulfillable_quantity AS fulfillableQty,
            afn_total_quantity AS totalQty,
            your_price AS price
        FROM dbo.T_amazon_fba_inventory_snapshot WITH(NOLOCK)
        WHERE store = %(store)s
          AND sku = %(sku)s
          AND report_generated_at >= DATEADD(DAY, -%(days)s, GETDATE())
        ORDER BY report_generated_at DESC
    """
    cur = conn.cursor()
    cur.execute(sql, {"store": store, "sku": sku, "days": days})
    rows = [serialize_row(r) for r in cur.fetchall()]
    cur.close()
    return rows


def main() -> None:
    req = read_request()
    op = req.get("op")
    try:
        conn = connect()
    except Exception as exc:
        emit({"error": "UpstreamError", "message": f"DB connect failed: {exc}"}, 2)

    try:
        if op == "currentInventory":
            rows = current_inventory(
                conn,
                store=req["store"],
                sku=req.get("sku"),
                top=int(req.get("top", 50)),
            )
        elif op == "lowStock":
            rows = low_stock(
                conn,
                store=req["store"],
                fulfillable_lt=int(req["fulfillableLessThan"]),
                top=int(req.get("top", 50)),
            )
        elif op == "snapshotHistory":
            rows = snapshot_history(
                conn,
                store=req["store"],
                sku=req["sku"],
                days=int(req.get("days", 30)),
            )
        else:
            emit({"error": "ValidationError", "message": f"unknown op: {op}"}, 1)
        emit({"rows": rows})
    except KeyError as exc:
        emit({"error": "ValidationError", "message": f"missing required field: {exc}"}, 1)
    except Exception as exc:
        emit({"error": "UpstreamError", "message": f"query failed: {exc}"}, 2)
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
