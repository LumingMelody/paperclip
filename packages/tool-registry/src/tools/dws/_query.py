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
        read_timeout=20,
        cursorclass=DictCursor,
    )


def resolve_account_id(conn, account: str) -> int:
    # dws_od_amazon_refund_rate_d only carries numeric accountId; ods_sp_me_platform_account_m
    # is the canonical store map (userAccount string -> accountId, 1:1).
    with conn.cursor() as cur:
        cur.execute(
            "SELECT accountId FROM ods_sp_me_platform_account_m "
            "WHERE userAccount = %(account)s AND accountId IS NOT NULL LIMIT 1",
            {"account": account},
        )
        row = cur.fetchone()
    if not row or row.get("accountId") is None:
        emit({"error": "ValidationError", "message": f"unknown account: {account!r} (no accountId mapping)"}, 1)
    return int(row["accountId"])


def return_reasons(conn, account_id: int, since: str, sku: str | None, top: int) -> list[dict[str, Any]]:
    sql = """
        SELECT
            return_reason AS returnReason,
            COUNT(*) AS returnCount,
            COUNT(DISTINCT sku) AS skuCount,
            COUNT(DISTINCT orderid) AS orderCount,
            CAST(COALESCE(SUM(rf_quantity), 0) AS DECIMAL(20,0)) AS unitsReturned
        FROM (
            SELECT
                returnReason AS return_reason,
                seller_sku AS sku,
                amazon_order_id AS orderid,
                rf_quantity
            FROM dws_od_amazon_refund_rate_d
            WHERE accountId = %(account_id)s
              AND check_date >= %(since)s
        ) src
        WHERE 1 = 1
          AND return_reason IS NOT NULL
          AND return_reason != ''
    """
    params: dict[str, Any] = {"account_id": account_id, "since": since}
    if sku:
        sql += " AND sku = %(sku)s"
        params["sku"] = sku
    sql += " GROUP BY return_reason ORDER BY returnCount DESC LIMIT %(top)s"
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def returns_by_sku(conn, account_id: int, since: str, top: int) -> list[dict[str, Any]]:
    # Per-SKU return totals + their dominant reason via window function.
    sql = """
        WITH src AS (
            SELECT
                seller_sku AS sku,
                returnReason AS return_reason,
                amazon_order_id AS orderid,
                rf_quantity
            FROM dws_od_amazon_refund_rate_d
            WHERE accountId = %(account_id)s
              AND check_date >= %(since)s
        ),
        sku_totals AS (
            SELECT
                sku,
                COUNT(*) AS returnCount,
                CAST(COALESCE(SUM(rf_quantity), 0) AS DECIMAL(20,0)) AS unitsReturned,
                COUNT(DISTINCT orderid) AS orderCount
            FROM src
            WHERE sku IS NOT NULL AND sku != ''
            GROUP BY sku
        ),
        reason_per_sku AS (
            SELECT sku, return_reason, ct,
                   ROW_NUMBER() OVER (PARTITION BY sku ORDER BY ct DESC) AS rn
            FROM (
                SELECT sku, return_reason, COUNT(*) AS ct
                FROM src
                WHERE sku IS NOT NULL AND sku != ''
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
        cur.execute(sql, {"account_id": account_id, "since": since, "top": top})
        return [serialize_row(r) for r in cur.fetchall()]


def return_rate_by_style(
    conn,
    account_id: int,
    since: str,
    until: str | None,
    top: int,
    min_qty: int,
    maturity_days: int,
    style: str | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "account_id": account_id,
        "since": since,
        "until": until,
        "top": top,
        "min_qty": min_qty,
        "maturity_days": maturity_days,
    }
    metadata_sql = """
        WITH bounds AS (
            SELECT
                CURDATE() AS asOfDate,
                DATE_FORMAT(%(since)s, '%%Y-%%m') AS requestedStartMonth,
                CASE
                    WHEN %(until)s IS NULL THEN '9999-99'
                    ELSE DATE_FORMAT(%(until)s, '%%Y-%%m')
                END AS requestedEndExclusiveMonth,
                DATE_FORMAT(
                    DATE_ADD(DATE_SUB(CURDATE(), INTERVAL %(maturity_days)s DAY), INTERVAL 1 DAY),
                    '%%Y-%%m'
                ) AS firstImmatureMonth
        ),
        effective AS (
            SELECT
                asOfDate,
                requestedStartMonth,
                firstImmatureMonth,
                LEAST(requestedEndExclusiveMonth, firstImmatureMonth) AS effectiveEndExclusiveMonth
            FROM bounds
        )
        SELECT
            asOfDate,
            requestedStartMonth AS windowStart,
            effectiveEndExclusiveMonth AS windowEnd,
            CASE
                WHEN effectiveEndExclusiveMonth <= requestedStartMonth THEN NULL
                ELSE DATE_FORMAT(
                    DATE_SUB(
                        STR_TO_DATE(CONCAT(effectiveEndExclusiveMonth, '-01'), '%%Y-%%m-%%d'),
                        INTERVAL 1 MONTH
                    ),
                    '%%Y-%%m'
                )
            END AS coveredThrough,
            %(maturity_days)s AS maturityDays,
            FALSE AS windowIncludesImmature,
            'sale_month' AS cohortBasis,
            requestedStartMonth,
            firstImmatureMonth,
            CASE
                WHEN effectiveEndExclusiveMonth <= requestedStartMonth THEN NULL
                ELSE DATE_FORMAT(
                    DATE_SUB(
                        STR_TO_DATE(CONCAT(effectiveEndExclusiveMonth, '-01'), '%%Y-%%m-%%d'),
                        INTERVAL 1 MONTH
                    ),
                    '%%Y-%%m'
                )
            END AS matureThroughMonth,
            CASE
                WHEN effectiveEndExclusiveMonth <= requestedStartMonth THEN TRUE
                ELSE FALSE
            END AS allImmature
        FROM effective
    """
    with conn.cursor() as cur:
        cur.execute(metadata_sql, params)
        metadata = serialize_row(cur.fetchone())
    metadata["maturityDays"] = int(metadata["maturityDays"])
    metadata["windowIncludesImmature"] = bool(metadata["windowIncludesImmature"])
    metadata["allImmature"] = bool(metadata["allImmature"])
    if metadata["allImmature"]:
        return {"rows": [], **metadata}

    sql = """
        SELECT
            sku_left7 AS styleCode,
            CAST(COALESCE(SUM(quantity),0) AS DECIMAL(20,0)) AS salesQty,
            CAST(COALESCE(SUM(rf_quantity),0) AS DECIMAL(20,0)) AS returnQty,
            COUNT(DISTINCT seller_sku) AS skuCount
        FROM dws_od_amazon_refund_rate_d
        WHERE accountId=%(account_id)s
          AND yearmouth >= DATE_FORMAT(%(since)s, '%%Y-%%m')
          AND yearmouth < LEAST(
              CASE
                  WHEN %(until)s IS NULL THEN '9999-99'
                  ELSE DATE_FORMAT(%(until)s, '%%Y-%%m')
              END,
              DATE_FORMAT(
                  DATE_ADD(DATE_SUB(CURDATE(), INTERVAL %(maturity_days)s DAY), INTERVAL 1 DAY),
                  '%%Y-%%m'
              )
          )
          AND sku_left7 IS NOT NULL AND sku_left7<>''
    """
    if style is not None:
        sql += " AND sku_left7 = %(style)s"
        params["style"] = style
    sql += " GROUP BY sku_left7"
    if style is None:
        sql += """
            HAVING SUM(quantity) >= %(min_qty)s
            ORDER BY (SUM(rf_quantity)/NULLIF(SUM(quantity),0)) DESC
            LIMIT %(top)s
        """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = []
    for r in rows:
        row = serialize_row(r)
        sales_qty = float(row["salesQty"])
        return_qty = float(row["returnQty"])
        row["returnRate"] = round(return_qty / sales_qty, 4) if sales_qty > 0 else None
        out.append(row)
    return {"rows": out, **metadata}


def amazon_sales_by_style(
    conn,
    account: str,
    since: str,
    until: str | None,
    top: int,
    style: str | None = None,
) -> dict[str, Any]:
    sql = """
        SELECT
            LEFT(processed_sku,7) AS styleCode,
            CAST(COALESCE(SUM(qty),0) AS DECIMAL(20,0)) AS salesQty,
            COUNT(DISTINCT order_id) AS orderCount,
            COUNT(DISTINCT processed_sku) AS skuCount,
            MIN(DATE(statistic_time_local)) AS firstSaleDate,
            MAX(DATE(statistic_time_local)) AS lastSaleDate
        FROM dws_od_amazon_order_d
        WHERE Account=%(account)s AND statistic_time_local>=%(since)s
          AND is_allcard IN (0,1)
          AND original_sku IS NOT NULL AND original_sku<>'' AND original_sku NOT LIKE 'YS%%'
          AND processed_sku IS NOT NULL AND processed_sku<>''
    """
    params: dict[str, Any] = {"account": account, "since": since, "top": top}
    if until:
        sql += " AND statistic_time_local < %(until)s"
        params["until"] = until
    if style is not None:
        sql += " AND LEFT(processed_sku,7)=%(style)s"
        params["style"] = style
    sql += " GROUP BY LEFT(processed_sku,7)"
    if style is None:
        sql += " ORDER BY salesQty DESC LIMIT %(top)s"
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = [serialize_row(r) for r in cur.fetchall()]

    metadata_sql = """
        SELECT
            CURDATE() AS asOfDate,
            %(since)s AS windowStart,
            CAST(%(until)s AS DATE) AS windowEnd,
            CASE
                WHEN %(until)s IS NULL THEN NULL
                ELSE CAST(DATE_SUB(CAST(%(until)s AS DATE), INTERVAL 1 DAY) AS DATE)
            END AS coveredThrough
    """
    with conn.cursor() as cur:
        cur.execute(metadata_sql, {"since": since, "until": until})
        metadata = serialize_row(cur.fetchone())
    return {"rows": rows, **metadata}


def sales_summary(
    conn,
    since: str,
    until: str | None,
    group_by: str,
    platform: str | None,
    account: str | None,
    style: str | None,
    top: int | None,
) -> dict[str, Any]:
    group_exprs = {
        "platform": "order_plat",
        "account": "Account",
        "bu": "performance_fir",
        "country": "countryName",
        "day": "DATE(statistic_time_local)",
        "month": "DATE_FORMAT(statistic_time_local,'%%Y-%%m')",
        "style": "LEFT(processed_sku,7)",
        "none": "'ALL'",
    }
    if group_by not in group_exprs:
        emit(
            {
                "error": "ValidationError",
                "message": "groupBy must be platform/account/bu/country/day/month/style/none",
            },
            1,
        )
    group_expr = group_exprs[group_by]
    sql = f"""
        SELECT
            {group_expr} AS groupKey,
            ROUND(COALESCE(SUM(CASE WHEN is_allcard=0 THEN actual_pay ELSE 0 END),0),4) AS gmv,
            COALESCE(SUM(CASE WHEN is_allcard IN (0,1) AND original_sku NOT LIKE 'YS%%' THEN qty ELSE 0 END),0) AS units,
            COUNT(DISTINCT order_id) AS orderCount,
            ROUND(COALESCE(SUM(CASE WHEN (is_allcard=0 OR is_allcard IS NULL) AND refund_statistic_time IS NOT NULL THEN refund_price ELSE 0 END),0),4) AS refundAmount,
            ROUND(COUNT(DISTINCT CASE WHEN refund_order_id IS NOT NULL THEN order_id END) / NULLIF(COUNT(DISTINCT order_id),0), 6) AS refundRate,
            ROUND(COALESCE(SUM(CASE WHEN is_allcard=0 THEN actual_pay ELSE 0 END),0) - COALESCE(SUM(CASE WHEN (is_allcard=0 OR is_allcard IS NULL) AND refund_statistic_time IS NOT NULL THEN refund_price ELSE 0 END),0), 4) AS netSales
        FROM dwa_od_order_d_v1
        WHERE statistic_time_local >= %(since)s
          AND original_sku <> ''
    """
    params: dict[str, Any] = {"since": since}
    if until:
        sql += " AND statistic_time_local < %(until)s"
        params["until"] = until
    if platform:
        sql += " AND order_plat = %(platform)s"
        params["platform"] = platform
    if account:
        sql += " AND Account = %(account)s"
        params["account"] = account
    if group_by == "style" or style is not None:
        sql += " AND processed_sku IS NOT NULL AND processed_sku <> ''"
    if style is not None:
        # Sargable prefix match (can use a processed_sku index) instead of
        # LEFT(processed_sku,7)=style, which is non-sargable and forces a full
        # scan of the window — fatal on the multi-platform wide table over a
        # multi-week range. style is bound as a value, so its trailing % is a
        # literal LIKE wildcard (no %% escaping needed for bound params).
        sql += " AND processed_sku LIKE %(style_prefix)s"
        params["style_prefix"] = style + "%"
    if group_by != "none":
        sql += f" GROUP BY {group_expr}"
    if group_by in ("day", "month"):
        sql += " ORDER BY groupKey ASC"
    else:
        sql += " ORDER BY gmv DESC"
    if group_by not in ("none", "day", "month") and top is not None:
        sql += " LIMIT %(top)s"
        params["top"] = top
    def run_main_query() -> list[dict[str, Any]]:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return [serialize_row(r) for r in cur.fetchall()]

    def has_recent_wide_table_rows() -> bool:
        with conn.cursor() as cur:
            cur.execute(
                """
                    SELECT /*+ MAX_EXECUTION_TIME(3000) */ COUNT(*) AS c
                    FROM dwa_od_order_d_v1
                    WHERE statistic_time_local >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)
                """
            )
            row = cur.fetchone()
        return bool(row and int(row.get("c") or 0) > 0)

    main_error: Exception | None = None
    try:
        rows = run_main_query()
    except Exception as exc:
        main_error = exc
        rows = []

    if not rows:
        try:
            has_recent_rows = has_recent_wide_table_rows()
        except Exception:
            has_recent_rows = False

        if not has_recent_rows:
            emit(
                {
                    "error": "UpstreamError",
                    "message": "dwa_od_order_d_v1 正在全量刷新(DROP+INSERT)，暂时无法查询，请稍后重试",
                },
                2,
            )
        if main_error is not None:
            raise main_error

    metadata_sql = """
        SELECT
            CURDATE() AS asOfDate,
            %(since)s AS windowStart,
            CAST(%(until)s AS DATE) AS windowEnd,
            CASE
                WHEN %(until)s IS NULL THEN NULL
                ELSE CAST(DATE_SUB(CAST(%(until)s AS DATE), INTERVAL 1 DAY) AS DATE)
            END AS coveredThrough
    """
    with conn.cursor() as cur:
        cur.execute(metadata_sql, {"since": since, "until": until})
        metadata = serialize_row(cur.fetchone())
    return {"rows": rows, **metadata}


def cohort_metadata(conn, since: str, until: str | None, maturity_days: int) -> tuple[str, dict[str, Any]]:
    effective_until = "%(until)s" if until else "DATE_SUB(CURDATE(), INTERVAL %(maturity_days)s DAY)"
    params: dict[str, Any] = {"since": since, "maturity_days": maturity_days}
    if until:
        params["until"] = until
    metadata_sql = f"""
        SELECT
            CURDATE() AS asOfDate,
            %(since)s AS windowStart,
            CAST({effective_until} AS DATE) AS windowEnd,
            CAST(DATE_SUB(CAST({effective_until} AS DATE), INTERVAL 1 DAY) AS DATE) AS coveredThrough,
            %(maturity_days)s AS maturityDays,
            CASE
                WHEN {effective_until} > DATE_SUB(CURDATE(), INTERVAL %(maturity_days)s DAY) THEN TRUE
                ELSE FALSE
            END AS windowIncludesImmature
    """
    with conn.cursor() as cur:
        cur.execute(metadata_sql, params)
        metadata = serialize_row(cur.fetchone())
    metadata["maturityDays"] = int(metadata["maturityDays"])
    metadata["windowIncludesImmature"] = bool(metadata["windowIncludesImmature"])
    return effective_until, metadata


def site_return_rate_by_style(
    conn,
    account: str,
    since: str,
    until: str | None,
    top: int,
    min_qty: int,
    maturity_days: int,
    style: str | None = None,
) -> dict[str, Any]:
    effective_until, metadata = cohort_metadata(conn, since, until, maturity_days)
    sql = f"""
        SELECT
            LEFT(shipping_sku, 7) AS styleCode,
            CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS salesQty,
            CAST(COALESCE(SUM(COALESCE(return_quantity, 0)), 0) AS DECIMAL(20,0)) AS returnQty,
            COUNT(DISTINCT shipping_sku) AS skuCount
        FROM dm_od_shopify_resreturn_d
        WHERE account = %(account)s
          AND pay_time >= %(since)s
          AND pay_time < {effective_until}
          AND shipping_sku IS NOT NULL
          AND shipping_sku != ''
    """
    params: dict[str, Any] = {
        "account": account,
        "since": since,
        "top": top,
        "min_qty": min_qty,
        "maturity_days": maturity_days,
    }
    if until:
        params["until"] = until
    if style is not None:
        sql += " AND LEFT(shipping_sku, 7) = %(style)s"
        params["style"] = style
    sql += " GROUP BY LEFT(shipping_sku, 7)"
    if style is None:
        sql += """
            HAVING salesQty >= %(min_qty)s
            ORDER BY (SUM(COALESCE(return_quantity, 0)) / NULLIF(SUM(quantity), 0)) DESC
            LIMIT %(top)s
        """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = []
    for r in rows:
        row = serialize_row(r)
        sales_qty = float(row["salesQty"])
        return_qty = float(row["returnQty"])
        row["returnRate"] = round(return_qty / sales_qty, 4) if sales_qty > 0 else None
        out.append(row)
    return {"rows": out, **metadata}


def site_return_timing_by_style(
    conn,
    account: str,
    since: str,
    until: str | None,
    top: int,
    maturity_days: int,
    style: str | None = None,
) -> dict[str, Any]:
    effective_until, metadata = cohort_metadata(conn, since, until, maturity_days)
    sql = f"""
        SELECT
            LEFT(shipping_sku, 7) AS styleCode,
            CAST(COALESCE(SUM(COALESCE(return_quantity, 0)), 0) AS DECIMAL(20,0)) AS returnedQty,
            CAST(COALESCE(SUM(CASE
                WHEN DATEDIFF(return_time, pay_time) <= 30 THEN COALESCE(return_quantity, 0)
                ELSE 0
            END), 0) AS DECIMAL(20,0)) AS qty_0_30,
            CAST(COALESCE(SUM(CASE
                WHEN DATEDIFF(return_time, pay_time) BETWEEN 31 AND 45 THEN COALESCE(return_quantity, 0)
                ELSE 0
            END), 0) AS DECIMAL(20,0)) AS qty_31_45,
            CAST(COALESCE(SUM(CASE
                WHEN DATEDIFF(return_time, pay_time) > 45 THEN COALESCE(return_quantity, 0)
                ELSE 0
            END), 0) AS DECIMAL(20,0)) AS qty_45plus
        FROM dm_od_shopify_resreturn_d
        WHERE account = %(account)s
          AND pay_time >= %(since)s
          AND pay_time < {effective_until}
          AND return_quantity > 0
          AND return_time IS NOT NULL
          AND pay_time IS NOT NULL
          AND shipping_sku IS NOT NULL
          AND shipping_sku != ''
    """
    params: dict[str, Any] = {
        "account": account,
        "since": since,
        "top": top,
        "maturity_days": maturity_days,
    }
    if until:
        params["until"] = until
    if style is not None:
        sql += " AND LEFT(shipping_sku, 7) = %(style)s"
        params["style"] = style
    sql += " GROUP BY LEFT(shipping_sku, 7) ORDER BY returnedQty DESC LIMIT %(top)s"
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = []
    for r in rows:
        row = serialize_row(r)
        returned_qty = float(row["returnedQty"])
        for key in ("qty_0_30", "qty_31_45", "qty_45plus"):
            row[key] = float(row[key])
        row["pct_0_30"] = round(row["qty_0_30"] / returned_qty, 4) if returned_qty > 0 else None
        row["pct_31_45"] = round(row["qty_31_45"] / returned_qty, 4) if returned_qty > 0 else None
        row["pct_45plus"] = round(row["qty_45plus"] / returned_qty, 4) if returned_qty > 0 else None
        out.append(row)
    return {"rows": out, **metadata}


def site_return_rate_by_order_units(
    conn,
    account: str,
    since: str,
    until: str | None,
    maturity_days: int,
) -> dict[str, Any]:
    effective_until, metadata = cohort_metadata(conn, since, until, maturity_days)
    sql = f"""
        WITH order_totals AS (
            SELECT
                orderid,
                CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS orderSalesQty,
                CAST(COALESCE(SUM(COALESCE(return_quantity, 0)), 0) AS DECIMAL(20,0)) AS orderReturnQty
            FROM dm_od_shopify_resreturn_d
            WHERE account = %(account)s
              AND pay_time >= %(since)s
              AND pay_time < {effective_until}
              AND orderid IS NOT NULL
              AND orderid != ''
            GROUP BY orderid
        ),
        bucketed AS (
            SELECT
                CASE
                    WHEN orderSalesQty >= 5 THEN '5+'
                    ELSE CAST(orderSalesQty AS CHAR)
                END AS unitsBucket,
                orderSalesQty,
                orderReturnQty
            FROM order_totals
            WHERE orderSalesQty BETWEEN 1 AND 4 OR orderSalesQty >= 5
        )
        SELECT
            unitsBucket,
            COUNT(*) AS orderCount,
            CAST(COALESCE(SUM(orderSalesQty), 0) AS DECIMAL(20,0)) AS salesQty,
            CAST(COALESCE(SUM(orderReturnQty), 0) AS DECIMAL(20,0)) AS returnQty
        FROM bucketed
        GROUP BY unitsBucket
        ORDER BY FIELD(unitsBucket, '1', '2', '3', '4', '5+')
    """
    params: dict[str, Any] = {"account": account, "since": since, "maturity_days": maturity_days}
    if until:
        params["until"] = until
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = []
    for r in rows:
        row = serialize_row(r)
        sales_qty = float(row["salesQty"])
        return_qty = float(row["returnQty"])
        row["returnRate"] = round(return_qty / sales_qty, 4) if sales_qty > 0 else None
        out.append(row)
    return {"rows": out, **metadata}


def site_return_rate_by_warehouse(
    conn,
    account: str,
    since: str,
    until: str | None,
    maturity_days: int,
) -> dict[str, Any]:
    effective_until, metadata = cohort_metadata(conn, since, until, maturity_days)
    sql = f"""
        WITH src AS (
            SELECT
                CASE
                    WHEN warehouseName IS NULL OR TRIM(warehouseName) = '' OR warehouseName = '无仓库记录'
                    THEN '无仓库记录'
                    ELSE warehouseName
                END AS warehouseName,
                quantity,
                COALESCE(return_quantity, 0) AS return_quantity,
                CASE
                    WHEN warehouseName IS NULL OR TRIM(warehouseName) = '' OR warehouseName = '无仓库记录'
                    THEN 1
                    ELSE 0
                END AS isDirtyWarehouse
            FROM dm_od_shopify_resreturn_d
            WHERE account = %(account)s
              AND pay_time >= %(since)s
              AND pay_time < {effective_until}
        ),
        totals AS (
            SELECT
                CAST(COALESCE(SUM(return_quantity), 0) AS DECIMAL(20,0)) AS totalReturnQty,
                COUNT(*) AS totalRows,
                COALESCE(SUM(isDirtyWarehouse), 0) AS dirtyRows
            FROM src
        ),
        grouped AS (
            SELECT
                warehouseName,
                CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS salesQty,
                CAST(COALESCE(SUM(return_quantity), 0) AS DECIMAL(20,0)) AS returnQty
            FROM src
            GROUP BY warehouseName
        )
        SELECT
            g.warehouseName,
            g.salesQty,
            g.returnQty,
            CASE
                WHEN t.totalReturnQty > 0 THEN g.returnQty / t.totalReturnQty
                ELSE 0
            END AS returnShare,
            CASE
                WHEN t.totalRows > 0 THEN t.dirtyRows / t.totalRows
                ELSE 0
            END AS dirtyWarehousePct
        FROM grouped g
        CROSS JOIN totals t
        ORDER BY g.returnQty DESC, g.salesQty DESC
    """
    params: dict[str, Any] = {"account": account, "since": since, "maturity_days": maturity_days}
    if until:
        params["until"] = until
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = []
    dirty_warehouse_pct = 0.0
    for r in rows:
        row = serialize_row(r)
        sales_qty = float(row["salesQty"])
        return_qty = float(row["returnQty"])
        dirty_warehouse_pct = round(float(row.pop("dirtyWarehousePct") or 0), 4)
        row["returnRate"] = round(return_qty / sales_qty, 4) if sales_qty > 0 else None
        row["returnShare"] = round(float(row["returnShare"] or 0), 4)
        out.append(row)
    return {"rows": out, "dirtyWarehousePct": dirty_warehouse_pct, **metadata}


def site_top_styles(conn, account: str, since: str, top: int, style: str | None = None) -> list[dict[str, Any]]:
    sql = """
        SELECT
            style AS styleCode,
            CAST(COALESCE(SUM(qty),0) AS DECIMAL(20,0)) AS salesQty,
            COUNT(DISTINCT LEFT(sku,32)) AS skuCount,
            MAX(ProductTitle) AS productTitle
        FROM dwa_od_shopify_sale_d
        WHERE Account=%(account)s AND statistic_time_local>=%(since)s
              AND style IS NOT NULL AND style<>'' AND style NOT LIKE '%%00000'
    """
    params: dict[str, Any] = {"account": account, "since": since, "top": top}
    if style is not None:
        sql += " AND style=%(style)s"
        params["style"] = style
    sql += " GROUP BY style ORDER BY salesQty DESC LIMIT %(top)s"
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def site_slow_movers(
    conn,
    account: str,
    until: str | None,
    window_days: int,
    top: int,
    min_qty: int,
    sort: str,
) -> list[dict[str, Any]]:
    if sort not in ("decline", "slow"):
        emit({"error": "ValidationError", "message": f"sort must be 'decline' or 'slow', got {sort!r}"}, 1)
    anchor = "%(until)s" if until else "CURDATE()"
    order_sql = "(recentQty - priorQty) ASC" if sort == "decline" else "recentQty ASC"
    sql = f"""
        WITH w AS (
            SELECT
                style,
                SUM(CASE WHEN statistic_time_local >= DATE_SUB({anchor}, INTERVAL %(wd)s DAY)
                          AND statistic_time_local < {anchor} THEN qty ELSE 0 END) AS recentQty,
                SUM(CASE WHEN statistic_time_local >= DATE_SUB({anchor}, INTERVAL %(wd2)s DAY)
                          AND statistic_time_local < DATE_SUB({anchor}, INTERVAL %(wd)s DAY) THEN qty ELSE 0 END) AS priorQty
            FROM dwa_od_shopify_sale_d
            WHERE Account=%(account)s
              AND statistic_time_local >= DATE_SUB({anchor}, INTERVAL %(wd2)s DAY)
              AND statistic_time_local < {anchor}
              AND style IS NOT NULL AND style<>'' AND style NOT LIKE '%%00000'
            GROUP BY style
        )
        SELECT
            style AS styleCode,
            CAST(recentQty AS DECIMAL(20,0)) AS recentQty,
            CAST(priorQty AS DECIMAL(20,0)) AS priorQty,
            CAST(recentQty - priorQty AS DECIMAL(20,0)) AS deltaQty
        FROM w
        WHERE priorQty >= %(min_qty)s
        ORDER BY {order_sql}
        LIMIT %(top)s
    """
    params: dict[str, Any] = {
        "account": account,
        "wd": window_days,
        "wd2": window_days * 2,
        "min_qty": min_qty,
        "top": top,
    }
    if until:
        params["until"] = until
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = []
    for r in rows:
        row = serialize_row(r)
        prior = float(row["priorQty"])
        recent = float(row["recentQty"])
        row["dropPct"] = round((recent - prior) / prior, 4) if prior > 0 else None
        out.append(row)
    return out


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


def return_trend(conn, account_id: int, since: str, until: str, granularity: str) -> list[dict[str, Any]]:
    if granularity == "week":
        bucket_expr = "DATE_FORMAT(date, '%%x-W%%v')"
    elif granularity == "month":
        bucket_expr = "DATE_FORMAT(date, '%%Y-%%m')"
    elif granularity == "day":
        bucket_expr = "DATE_FORMAT(date, '%%Y-%%m-%%d')"
    else:
        emit({"error": "ValidationError", "message": f"granularity must be day/week/month, got {granularity!r}"}, 1)
    sql = f"""
        WITH src AS (
            SELECT
                check_date AS date,
                seller_sku AS sku,
                amazon_order_id AS orderid,
                quantity
            FROM dws_od_amazon_refund_rate_d
            WHERE accountId = %(account_id)s
              AND check_date >= %(since)s
              AND check_date < %(until)s
        )
        SELECT
            {bucket_expr} AS period,
            COUNT(*) AS returnCount,
            CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS unitsReturned,
            COUNT(DISTINCT sku) AS skuCount,
            COUNT(DISTINCT orderid) AS orderCount
        FROM src
        WHERE sku IS NOT NULL AND sku != ''
        GROUP BY period
        ORDER BY period
    """
    with conn.cursor() as cur:
        cur.execute(sql, {"account_id": account_id, "since": since, "until": until})
        return [serialize_row(r) for r in cur.fetchall()]


def skus_by_reason(conn, account_id: int, since: str, reasons: list[str], top: int) -> list[dict[str, Any]]:
    if not reasons:
        emit({"error": "ValidationError", "message": "reasons must be a non-empty list of reason codes"}, 1)
    placeholders = ",".join([f"%(r{i})s" for i in range(len(reasons))])
    sql = f"""
        WITH src AS (
            SELECT
                seller_sku AS sku,
                returnReason AS return_reason,
                quantity
            FROM dws_od_amazon_refund_rate_d
            WHERE accountId = %(account_id)s
              AND check_date >= %(since)s
        )
        SELECT
            sku,
            SUM(CASE WHEN return_reason IN ({placeholders}) THEN 1 ELSE 0 END) AS reasonReturnCount,
            CAST(SUM(CASE WHEN return_reason IN ({placeholders}) THEN COALESCE(quantity, 0) ELSE 0 END) AS DECIMAL(20,0)) AS reasonUnitsReturned,
            COUNT(*) AS totalReturnCount,
            CAST(COALESCE(SUM(quantity), 0) AS DECIMAL(20,0)) AS totalUnitsReturned
        FROM src
        WHERE sku IS NOT NULL AND sku != ''
        GROUP BY sku
        HAVING reasonReturnCount > 0
        ORDER BY reasonReturnCount DESC
        LIMIT %(top)s
    """
    params: dict[str, Any] = {"account_id": account_id, "since": since, "top": top}
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
            account_id = resolve_account_id(conn, req["account"])
            rows = return_reasons(
                conn,
                account_id=account_id,
                since=req["since"],
                sku=req.get("sku"),
                top=int(req.get("top", 10)),
            )
        elif op == "returnsBySku":
            account_id = resolve_account_id(conn, req["account"])
            rows = returns_by_sku(
                conn,
                account_id=account_id,
                since=req["since"],
                top=int(req.get("top", 20)),
            )
        elif op == "returnRateByStyle":
            account_id = resolve_account_id(conn, req["account"])
            result = return_rate_by_style(
                conn,
                account_id=account_id,
                since=req["since"],
                until=req.get("until"),
                top=int(req.get("top", 20)),
                min_qty=int(req.get("minQty", 50)),
                maturity_days=int(req.get("maturityDays", 45)),
                style=req.get("style"),
            )
            emit(result)
        elif op == "amazonSalesByStyle":
            result = amazon_sales_by_style(
                conn,
                account=req["account"],
                since=req["since"],
                until=req.get("until"),
                top=int(req.get("top", 20)),
                style=req.get("style"),
            )
            emit(result)
        elif op == "salesSummary":
            result = sales_summary(
                conn,
                since=req["since"],
                until=req.get("until"),
                group_by=req.get("groupBy", "platform"),
                platform=req.get("platform"),
                account=req.get("account"),
                style=req.get("style"),
                top=int(req["top"]) if req.get("top") is not None else None,
            )
            emit(result)
        elif op == "siteTopStyles":
            rows = site_top_styles(
                conn,
                account=req["account"],
                since=req["since"],
                top=int(req.get("top", 20)),
                style=req.get("style"),
            )
        elif op == "siteReturnRateByStyle":
            result = site_return_rate_by_style(
                conn,
                account=req["account"],
                since=req["since"],
                until=req.get("until"),
                top=int(req.get("top", 20)),
                min_qty=int(req.get("minQty", 50)),
                maturity_days=int(req.get("maturityDays", 45)),
                style=req.get("style"),
            )
            emit(result)
        elif op == "siteReturnTimingByStyle":
            result = site_return_timing_by_style(
                conn,
                account=req["account"],
                since=req["since"],
                until=req.get("until"),
                top=int(req.get("top", 20)),
                maturity_days=int(req.get("maturityDays", 45)),
                style=req.get("style"),
            )
            emit(result)
        elif op == "siteReturnRateByOrderUnits":
            result = site_return_rate_by_order_units(
                conn,
                account=req["account"],
                since=req["since"],
                until=req.get("until"),
                maturity_days=int(req.get("maturityDays", 45)),
            )
            emit(result)
        elif op == "siteReturnRateByWarehouse":
            result = site_return_rate_by_warehouse(
                conn,
                account=req["account"],
                since=req["since"],
                until=req.get("until"),
                maturity_days=int(req.get("maturityDays", 45)),
            )
            emit(result)
        elif op == "siteSlowMovers":
            rows = site_slow_movers(
                conn,
                account=req["account"],
                until=req.get("until"),
                window_days=int(req.get("windowDays", 30)),
                top=int(req.get("top", 20)),
                min_qty=int(req.get("minQty", 30)),
                sort=req.get("sort", "decline"),
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
            account_id = resolve_account_id(conn, req["account"])
            rows = return_trend(
                conn,
                account_id=account_id,
                since=req["since"],
                until=req["until"],
                granularity=req.get("granularity", "week"),
            )
        elif op == "skusByReason":
            account_id = resolve_account_id(conn, req["account"])
            rows = skus_by_reason(
                conn,
                account_id=account_id,
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
