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
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:
    emit(
        {"error": "UpstreamError", "message": "pymysql not available; run: uv pip install pymysql"},
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
    missing = [k for k in ("DWS_DB_HOST", "DWS_DB_USER", "DWS_DB_PASSWORD", "DWS_DB_DATABASE") if not os.environ.get(k)]
    if missing:
        emit({"error": "UpstreamError", "message": f"Missing database env vars: {', '.join(missing)}"}, 2)
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


def return_reasons(conn, account: str, since: str, sku: str | None, top: int) -> list[dict[str, Any]]:
    sql = """
        SELECT
            return_reason AS returnReason,
            COUNT(*) AS returnCount,
            COUNT(DISTINCT sku) AS skuCount,
            COUNT(DISTINCT orderid) AS orderCount,
            CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS unitsReturned
        FROM dm_allretrun_analysis_d
        WHERE Account = %(account)s
          AND date >= %(since)s
          AND return_reason IS NOT NULL
          AND return_reason != ''
    """
    params: dict[str, Any] = {"account": account, "since": since}
    if sku:
        sql += " AND sku = %(sku)s"
        params["sku"] = sku
    sql += " GROUP BY return_reason ORDER BY returnCount DESC LIMIT %(top)s"
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def returns_by_sku(conn, account: str, since: str, top: int) -> list[dict[str, Any]]:
    # Per-SKU return totals + their dominant reason via window function.
    sql = """
        WITH sku_totals AS (
            SELECT
                sku,
                COUNT(*) AS returnCount,
                CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS unitsReturned,
                COUNT(DISTINCT orderid) AS orderCount
            FROM dm_allretrun_analysis_d
            WHERE Account = %(account)s
              AND date >= %(since)s
              AND sku IS NOT NULL AND sku != ''
            GROUP BY sku
        ),
        reason_per_sku AS (
            SELECT sku, return_reason, ct,
                   ROW_NUMBER() OVER (PARTITION BY sku ORDER BY ct DESC) AS rn
            FROM (
                SELECT sku, return_reason, COUNT(*) AS ct
                FROM dm_allretrun_analysis_d
                WHERE Account = %(account)s
                  AND date >= %(since)s
                  AND sku IS NOT NULL AND sku != ''
                  AND return_reason IS NOT NULL AND return_reason != ''
                GROUP BY sku, return_reason
            ) t
        )
        SELECT
            t.sku AS sku,
            t.returnCount,
            t.unitsReturned,
            t.orderCount,
            r.return_reason AS topReason,
            r.ct AS topReasonCount
        FROM sku_totals t
        LEFT JOIN reason_per_sku r ON r.sku = t.sku AND r.rn = 1
        ORDER BY t.returnCount DESC
        LIMIT %(top)s
    """
    with conn.cursor() as cur:
        cur.execute(sql, {"account": account, "since": since, "top": top})
        return [serialize_row(r) for r in cur.fetchall()]


def return_detail(conn, account: str, sku: str, since: str, limit: int) -> list[dict[str, Any]]:
    sql = """
        SELECT
            date AS eventDate,
            sku,
            orderid AS orderId,
            rma,
            quantity,
            rf_quantity AS refundQuantity,
            return_reason AS returnReason,
            reason_description AS reasonDescription,
            performance_fir AS owner,
            warehouse
        FROM dm_allretrun_analysis_d
        WHERE Account = %(account)s
          AND sku = %(sku)s
          AND date >= %(since)s
        ORDER BY date DESC
        LIMIT %(limit)s
    """
    with conn.cursor() as cur:
        cur.execute(sql, {"account": account, "sku": sku, "since": since, "limit": limit})
        return [serialize_row(r) for r in cur.fetchall()]


def refund_comments(conn, account: str, since: str, sku_prefix: str | None, limit: int) -> list[dict[str, Any]]:
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
        return [serialize_row(r) for r in cur.fetchall()]


def return_trend(conn, account: str, since: str, until: str, granularity: str) -> list[dict[str, Any]]:
    if granularity == "week":
        bucket_expr = "DATE_FORMAT(date, '%%x-W%%v')"
    elif granularity == "month":
        bucket_expr = "DATE_FORMAT(date, '%%Y-%%m')"
    elif granularity == "day":
        bucket_expr = "DATE_FORMAT(date, '%%Y-%%m-%%d')"
    else:
        emit({"error": "ValidationError", "message": f"granularity must be day/week/month, got {granularity!r}"}, 1)
    sql = f"""
        SELECT
            {bucket_expr} AS period,
            COUNT(*) AS returnCount,
            CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS unitsReturned,
            COUNT(DISTINCT sku) AS skuCount,
            COUNT(DISTINCT orderid) AS orderCount
        FROM dm_allretrun_analysis_d
        WHERE Account = %(account)s
          AND date >= %(since)s
          AND date < %(until)s
          AND sku IS NOT NULL AND sku != ''
        GROUP BY period
        ORDER BY period
    """
    with conn.cursor() as cur:
        cur.execute(sql, {"account": account, "since": since, "until": until})
        return [serialize_row(r) for r in cur.fetchall()]


def skus_by_reason(conn, account: str, since: str, reasons: list[str], top: int) -> list[dict[str, Any]]:
    if not reasons:
        emit({"error": "ValidationError", "message": "reasons must be a non-empty list of reason codes"}, 1)
    placeholders = ",".join([f"%(r{i})s" for i in range(len(reasons))])
    sql = f"""
        SELECT
            sku,
            SUM(CASE WHEN return_reason IN ({placeholders}) THEN 1 ELSE 0 END) AS reasonReturnCount,
            CAST(SUM(CASE WHEN return_reason IN ({placeholders}) THEN COALESCE(quantity, 0) ELSE 0 END) AS DECIMAL(20,0)) AS reasonUnitsReturned,
            COUNT(*) AS totalReturnCount,
            CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS totalUnitsReturned
        FROM dm_allretrun_analysis_d
        WHERE Account = %(account)s
          AND date >= %(since)s
          AND sku IS NOT NULL AND sku != ''
        GROUP BY sku
        HAVING reasonReturnCount > 0
        ORDER BY reasonReturnCount DESC
        LIMIT %(top)s
    """
    params: dict[str, Any] = {"account": account, "since": since, "top": top}
    for i, r in enumerate(reasons):
        params[f"r{i}"] = r
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = []
    for r in rows:
        row = serialize_row(r)
        total = float(row.get("totalReturnCount") or 0)
        reason_n = float(row.get("reasonReturnCount") or 0)
        row["reasonShareOfSku"] = round(reason_n / total, 4) if total > 0 else 0.0
        out.append(row)
    return out


def main() -> None:
    req = read_request()
    op = req.get("op")
    try:
        conn = connect()
    except Exception as exc:
        emit({"error": "UpstreamError", "message": f"DB connect failed: {exc}"}, 2)

    try:
        if op == "returnReasons":
            rows = return_reasons(
                conn,
                account=req["account"],
                since=req["since"],
                sku=req.get("sku"),
                top=int(req.get("top", 10)),
            )
        elif op == "returnsBySku":
            rows = returns_by_sku(
                conn,
                account=req["account"],
                since=req["since"],
                top=int(req.get("top", 20)),
            )
        elif op == "returnDetail":
            rows = return_detail(
                conn,
                account=req["account"],
                sku=req["sku"],
                since=req["since"],
                limit=int(req.get("limit", 20)),
            )
        elif op == "refundComments":
            rows = refund_comments(
                conn,
                account=req["account"],
                since=req["since"],
                sku_prefix=req.get("skuPrefix"),
                limit=int(req.get("limit", 20)),
            )
        elif op == "returnTrend":
            rows = return_trend(
                conn,
                account=req["account"],
                since=req["since"],
                until=req["until"],
                granularity=req.get("granularity", "week"),
            )
        elif op == "skusByReason":
            rows = skus_by_reason(
                conn,
                account=req["account"],
                since=req["since"],
                reasons=req.get("reasons") or [],
                top=int(req.get("top", 10)),
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
