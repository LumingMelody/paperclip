#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from typing import Any


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:
    emit(
        {
            "error": "UpstreamError",
            "message": "pymysql not available; run: uv pip install pymysql",
        },
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
    return payload


def connect():
    missing = [
        key
        for key in [
            "LINGXING_DB_HOST",
            "LINGXING_DB_USER",
            "LINGXING_DB_PASSWORD",
            "LINGXING_DB_DATABASE",
        ]
        if not os.environ.get(key)
    ]
    if missing:
        emit({"error": "UpstreamError", "message": f"Missing database env vars: {', '.join(missing)}"}, 2)

    kwargs: dict[str, Any] = {
        "host": os.environ["LINGXING_DB_HOST"],
        "port": int(os.environ.get("LINGXING_DB_PORT") or "3306"),
        "user": os.environ["LINGXING_DB_USER"],
        "password": os.environ["LINGXING_DB_PASSWORD"],
        "database": os.environ["LINGXING_DB_DATABASE"],
        "charset": "utf8mb4",
        "connect_timeout": 8,
        "cursorclass": DictCursor,
    }
    return pymysql.connect(**kwargs)


def fact_sku(conn, asin: str) -> dict[str, Any] | None:
    sql = """
        SELECT
            m.asin AS asin,
            m.parent_asin AS parentAsin,
            m.sku AS sellerSku,
            m.item_name AS productTitle,
            m.sid AS shopSid,
            m.shop_name AS shopName,
            m.currency_code AS currencyCode,
            MIN(m.start_date) AS firstSeen,
            MAX(m.end_date) AS lastSeen,
            SUM(COALESCE(m.volume, 0)) AS orderQty,
            SUM(COALESCE(m.amount, 0)) AS gmvLocal,
            SUM(COALESCE(m.return_count, 0)) AS returnCount,
            MAX(m.avg_star) AS avgRating,
            MAX(m.reviews_count) AS reviewsCount
        FROM lx_product_msku m
        WHERE m.asin = %s
        GROUP BY
            m.asin,
            m.parent_asin,
            m.sku,
            m.item_name,
            m.sid,
            m.shop_name,
            m.currency_code
        ORDER BY orderQty DESC
        LIMIT 1
    """
    with conn.cursor() as cur:
        cur.execute(sql, (asin,))
        row = cur.fetchone()
    return serialize_row(row) if row else None


def fact_orders(conn, sku_id: str, since: str) -> list[dict[str, Any]]:
    sql = """
        SELECT
            m.sku AS skuId,
            m.asin AS asin,
            m.start_date AS startDate,
            m.end_date AS endDate,
            SUM(COALESCE(m.volume, 0)) AS orderQty,
            SUM(COALESCE(m.amount, 0)) AS gmvLocal,
            SUM(COALESCE(m.return_count, 0)) AS returnCount,
            SUM(COALESCE(m.order_items, 0)) AS orderItems,
            AVG(m.avg_custom_price) AS avgSellingPrice,
            SUM(COALESCE(m.spend, 0)) AS adSpendLocal,
            SUM(COALESCE(m.ad_sales_amount, 0)) AS adSalesAmount
        FROM lx_product_msku m
        WHERE m.sku = %s
          AND m.start_date >= %s
        GROUP BY
            m.sku,
            m.asin,
            m.start_date,
            m.end_date
        ORDER BY m.start_date ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql, (sku_id, since))
        rows = cur.fetchall()
    return [serialize_row(row) for row in rows]


def main() -> None:
    request = read_request()
    op = request.get("op")
    try:
        conn = connect()
        try:
            if op == "factSku":
                asin = request.get("asin")
                if not isinstance(asin, str):
                    emit({"error": "ValidationError", "message": "factSku requires asin"}, 1)
                emit({"row": fact_sku(conn, asin)})
            if op == "factOrders":
                sku_id = request.get("skuId")
                since = request.get("since")
                if not isinstance(sku_id, str) or not isinstance(since, str):
                    emit({"error": "ValidationError", "message": "factOrders requires skuId and since"}, 1)
                emit({"rows": fact_orders(conn, sku_id, since)})
            emit({"error": "ValidationError", "message": f"Unknown op: {op}"}, 1)
        finally:
            conn.close()
    except SystemExit:
        raise
    except Exception as exc:
        emit({"error": "UpstreamError", "message": f"Lingxing query failed: {exc}"}, 2)


if __name__ == "__main__":
    main()
