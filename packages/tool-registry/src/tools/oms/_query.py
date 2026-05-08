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
    missing = [k for k in ("OMS_DB_HOST", "OMS_DB_USER", "OMS_DB_PASSWORD", "OMS_DB_DATABASE") if not os.environ.get(k)]
    if missing:
        emit({"error": "UpstreamError", "message": f"Missing database env vars: {', '.join(missing)}"}, 2)
    return pymysql.connect(
        host=os.environ["OMS_DB_HOST"],
        port=int(os.environ.get("OMS_DB_PORT") or "3306"),
        user=os.environ["OMS_DB_USER"],
        password=os.environ["OMS_DB_PASSWORD"],
        database=os.environ["OMS_DB_DATABASE"],
        charset="utf8mb4",
        connect_timeout=8,
        cursorclass=DictCursor,
    )


def sales_by_channel(conn, since: str, until: str | None) -> list[dict[str, Any]]:
    sql = """
        SELECT
            COALESCE(NULLIF(sales_channel, ''), '(unknown)') AS salesChannel,
            currency,
            COUNT(*) AS orderCount,
            CAST(COALESCE(SUM(sales_order_total), 0) AS DECIMAL(20,4)) AS gmv,
            CAST(COALESCE(SUM(ship_amount), 0) AS DECIMAL(20,4)) AS shipAmount,
            CAST(COALESCE(SUM(total_discounts), 0) AS DECIMAL(20,4)) AS discountAmount,
            CAST(AVG(sales_order_total) AS DECIMAL(20,4)) AS avgOrderValue
        FROM sales_order
        WHERE order_date >= %(since)s
    """
    params: dict[str, Any] = {"since": since}
    if until:
        sql += " AND order_date < %(until)s"
        params["until"] = until
    sql += " GROUP BY salesChannel, currency ORDER BY gmv DESC"
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def b2b_customer_ranking(conn, since: str, until: str | None, top: int) -> list[dict[str, Any]]:
    sql = """
        SELECT
            COALESCE(NULLIF(customer_email, ''), '(unknown)') AS customerEmail,
            MAX(NULLIF(CONCAT_WS(' ', customer_first_name, customer_last_name), ' ')) AS customerName,
            MAX(customer_state) AS customerState,
            COUNT(*) AS orderCount,
            CAST(COALESCE(SUM(total_price), 0) AS DECIMAL(20,4)) AS totalGmv,
            CAST(COALESCE(AVG(total_price), 0) AS DECIMAL(20,4)) AS avgOrderValue,
            MAX(currency) AS currency,
            MIN(order_created_at) AS firstOrderDate,
            MAX(order_created_at) AS lastOrderDate,
            DATEDIFF(CURRENT_DATE, MAX(order_created_at)) AS daysSinceLastOrder,
            SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) AS paidCount,
            SUM(CASE WHEN financial_status IN ('refunded', 'partially_refunded') THEN 1 ELSE 0 END) AS refundedCount
        FROM shopify_order
        WHERE name LIKE 'E4WHOLESALE%%'
          AND order_created_at >= %(since)s
    """
    params: dict[str, Any] = {"since": since}
    if until:
        sql += " AND order_created_at < %(until)s"
        params["until"] = until
    sql += """
        GROUP BY customerEmail
        HAVING customerEmail != '(unknown)'
        ORDER BY totalGmv DESC
        LIMIT %(top)s
    """
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def dormant_b2b_customers(
    conn,
    since: str,
    until: str | None,
    dormancy_days: int,
    include_disabled: bool,
    top: int,
) -> list[dict[str, Any]]:
    sql = """
        SELECT
            COALESCE(NULLIF(customer_email, ''), '(unknown)') AS customerEmail,
            MAX(NULLIF(CONCAT_WS(' ', customer_first_name, customer_last_name), ' ')) AS customerName,
            MAX(customer_state) AS customerState,
            COUNT(*) AS orderCount,
            CAST(COALESCE(SUM(total_price), 0) AS DECIMAL(20,4)) AS totalGmv,
            CAST(COALESCE(AVG(total_price), 0) AS DECIMAL(20,4)) AS avgOrderValue,
            MAX(currency) AS currency,
            MIN(order_created_at) AS firstOrderDate,
            MAX(order_created_at) AS lastOrderDate,
            DATEDIFF(CURRENT_DATE, MAX(order_created_at)) AS daysSinceLastOrder,
            SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) AS paidCount,
            SUM(CASE WHEN financial_status IN ('refunded', 'partially_refunded') THEN 1 ELSE 0 END) AS refundedCount
        FROM shopify_order
        WHERE name LIKE 'E4WHOLESALE%%'
          AND order_created_at >= %(since)s
    """
    params: dict[str, Any] = {"since": since}
    if until:
        sql += " AND order_created_at < %(until)s"
        params["until"] = until
    sql += """
        GROUP BY customerEmail
        HAVING customerEmail != '(unknown)'
    """
    if include_disabled:
        sql += """
           AND (
               DATEDIFF(CURRENT_DATE, MAX(order_created_at)) >= %(dormancy_days)s
               OR MAX(customer_state) = 'disabled'
           )
        """
    else:
        sql += """
           AND DATEDIFF(CURRENT_DATE, MAX(order_created_at)) >= %(dormancy_days)s
        """
    sql += """
        ORDER BY daysSinceLastOrder DESC, totalGmv DESC
        LIMIT %(top)s
    """
    params["dormancy_days"] = dormancy_days
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def inventory_by_warehouse(
    conn,
    sku: str | None,
    warehouse_code: str | None,
    country: str | None,
    warehouse_type: str | None,
    min_available: int,
    top: int,
) -> list[dict[str, Any]]:
    sql = """
        SELECT
            i.sku_code AS sku,
            w.warehouse_code AS warehouseCode,
            w.warehouse_name AS warehouseName,
            w.warehouse_type AS warehouseType,
            w.country_code AS countryCode,
            i.physical_quantity AS physicalQuantity,
            i.available_quantity AS availableQuantity,
            i.frozen_quantity AS frozenQuantity,
            i.transit_in_quantity AS transitInQuantity,
            i.transit_out_quantity AS transitOutQuantity,
            i.defective_quantity AS defectiveQuantity,
            i.last_sync_time AS lastSyncTime
        FROM inventory i
        JOIN warehouses w ON i.warehouse_id = w.id
        WHERE i.deleted = 0
          AND w.is_active = 1
          AND i.available_quantity >= %(min_available)s
    """
    params: dict[str, Any] = {"min_available": min_available}
    if sku:
        sql += " AND i.sku_code = %(sku)s"
        params["sku"] = sku
    if warehouse_code:
        sql += " AND w.warehouse_code = %(warehouse_code)s"
        params["warehouse_code"] = warehouse_code
    if country:
        sql += " AND w.country_code = %(country)s"
        params["country"] = country
    if warehouse_type:
        sql += " AND w.warehouse_type = %(warehouse_type)s"
        params["warehouse_type"] = warehouse_type
    sql += " ORDER BY i.available_quantity DESC LIMIT %(top)s"
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def main() -> None:
    req = read_request()
    op = req.get("op")
    try:
        conn = connect()
    except Exception as exc:
        emit({"error": "UpstreamError", "message": f"DB connect failed: {exc}"}, 2)

    try:
        if op == "salesByChannel":
            rows = sales_by_channel(
                conn,
                since=req["since"],
                until=req.get("until"),
            )
        elif op == "b2bCustomerRanking":
            rows = b2b_customer_ranking(
                conn,
                since=req["since"],
                until=req.get("until"),
                top=int(req.get("top", 20)),
            )
        elif op == "dormantB2bCustomers":
            rows = dormant_b2b_customers(
                conn,
                since=req["since"],
                until=req.get("until"),
                dormancy_days=int(req.get("dormancyDays", 30)),
                include_disabled=bool(req.get("includeDisabled", True)),
                top=int(req.get("top", 30)),
            )
        elif op == "inventoryByWarehouse":
            rows = inventory_by_warehouse(
                conn,
                sku=req.get("sku"),
                warehouse_code=req.get("warehouseCode"),
                country=req.get("country"),
                warehouse_type=req.get("warehouseType"),
                min_available=int(req.get("minAvailable", 0)),
                top=int(req.get("top", 50)),
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
