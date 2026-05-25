#!/usr/bin/env python3
"""Build and optionally push the EP weekly return report to DingTalk.

The script is intentionally self-contained so launchd can run it through the
thin shell wrapper in this directory:

    uv run python scripts/weekly_return_report.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pymysql
from loguru import logger
from pymysql.cursors import DictCursor


DEFAULT_SHOP = "EP-US"
DEFAULT_GROUP_NAME = "亚马逊库存机器人测试群"
DEFAULT_RAG_API_BASE = "http://127.0.0.1:9001"
DEFAULT_COLLECTION = "refund_comments"

TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken"
SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send"

_REQUIRED_DWS_ENV = ("DWS_DB_HOST", "DWS_DB_USER", "DWS_DB_PASSWORD", "DWS_DB_DATABASE")
_SHOP_RE = re.compile(r"^(EP|PZ|DAMA)-([A-Z]{2})$")
_ACCOUNT_RE = re.compile(r"^Amazon(EP|PZ|DAMA)([A-Z]{2})$")


@dataclass(frozen=True)
class WeekWindow:
    since: str
    until: str
    compare_since: str


@dataclass(frozen=True)
class ReportData:
    shop: str
    since: str
    until: str
    compare_since: str
    current_summary: dict[str, Any]
    previous_summary: dict[str, Any]
    current_reasons: list[dict[str, Any]]
    previous_reasons: list[dict[str, Any]]
    top_skus: list[dict[str, Any]]
    previous_sku_counts: dict[str, int]
    other_market_rows: list[dict[str, Any]]
    rag_answer: str | None
    rag_warning: str | None


def shop_to_account(shop: str) -> str:
    match = _SHOP_RE.match(shop)
    if not match:
        raise ValueError(f"shop must match /^(EP|PZ|DAMA)-[A-Z]{{2}}$/, got {shop!r}")
    return f"Amazon{match.group(1)}{match.group(2)}"


def account_to_shop(account: str) -> str:
    match = _ACCOUNT_RE.match(account)
    if not match:
        return account
    return f"{match.group(1)}-{match.group(2)}"


def default_window(today: date | None = None) -> WeekWindow:
    today = today or date.today()
    this_monday = today - timedelta(days=today.weekday())
    since = this_monday - timedelta(days=7)
    compare_since = this_monday - timedelta(days=14)
    return WeekWindow(
        since=since.isoformat(),
        until=this_monday.isoformat(),
        compare_since=compare_since.isoformat(),
    )


def _parse_iso_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {value!r}") from exc


def resolve_window(since_arg: str | None, until_arg: str | None) -> WeekWindow:
    default = default_window()
    since = _parse_iso_date(since_arg).isoformat() if since_arg else default.since
    until = _parse_iso_date(until_arg).isoformat() if until_arg else default.until
    if since >= until:
        raise ValueError(f"--since must be before --until, got {since} >= {until}")
    compare_since = (_parse_iso_date(since) - timedelta(days=7)).isoformat()
    return WeekWindow(since=since, until=until, compare_since=compare_since)


def _connect() -> pymysql.Connection:
    missing = [name for name in _REQUIRED_DWS_ENV if not os.environ.get(name)]
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


def _int(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, Decimal):
        return int(value)
    return int(value)


def _float(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def _fetch_one(conn: pymysql.Connection, sql: str, params: dict[str, Any]) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    return dict(row or {})


def _fetch_all(conn: pymysql.Connection, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]


def _account_exists_clause(alias: str = "r") -> str:
    return f"""
        EXISTS (
            SELECT 1
            FROM dm_allretrun_analysis_d d
            WHERE d.orderid = {alias}.amazon_order_id
              AND d.Account = %(account)s
        )
    """


def fetch_summary(
    conn: pymysql.Connection,
    account: str,
    since: str,
    until: str,
) -> dict[str, Any]:
    sql = f"""
        SELECT
            COUNT(*) AS return_count,
            COUNT(DISTINCT r.seller_sku) AS sku_count
        FROM dws_od_amazon_refund_rate_d r
        WHERE r.check_date >= %(since)s
          AND r.check_date < %(until)s
          AND r.seller_sku IS NOT NULL
          AND r.seller_sku != ''
          AND {_account_exists_clause("r")}
    """
    row = _fetch_one(conn, sql, {"account": account, "since": since, "until": until})
    return {
        "return_count": _int(row.get("return_count")),
        "sku_count": _int(row.get("sku_count")),
    }


def fetch_reason_counts(
    conn: pymysql.Connection,
    account: str,
    since: str,
    until: str,
) -> list[dict[str, Any]]:
    sql = f"""
        SELECT
            COALESCE(NULLIF(r.returnReason, ''), 'UNKNOWN') AS reason,
            COUNT(*) AS return_count
        FROM dws_od_amazon_refund_rate_d r
        WHERE r.check_date >= %(since)s
          AND r.check_date < %(until)s
          AND {_account_exists_clause("r")}
        GROUP BY reason
        ORDER BY return_count DESC, reason ASC
    """
    rows = _fetch_all(conn, sql, {"account": account, "since": since, "until": until})
    return [
        {"reason": str(row.get("reason") or "UNKNOWN"), "return_count": _int(row.get("return_count"))}
        for row in rows
    ]


def fetch_top_skus(
    conn: pymysql.Connection,
    account: str,
    since: str,
    until: str,
    top: int = 5,
) -> list[dict[str, Any]]:
    sql = f"""
        WITH reason_counts AS (
            SELECT
                r.seller_sku AS sku,
                COALESCE(NULLIF(r.returnReason, ''), 'UNKNOWN') AS reason,
                COUNT(*) AS reason_count
            FROM dws_od_amazon_refund_rate_d r
            WHERE r.check_date >= %(since)s
              AND r.check_date < %(until)s
              AND r.seller_sku IS NOT NULL
              AND r.seller_sku != ''
              AND {_account_exists_clause("r")}
            GROUP BY r.seller_sku, reason
        ),
        sku_totals AS (
            SELECT sku, SUM(reason_count) AS return_count
            FROM reason_counts
            GROUP BY sku
        ),
        ranked_reasons AS (
            SELECT
                sku,
                reason,
                reason_count,
                ROW_NUMBER() OVER (
                    PARTITION BY sku
                    ORDER BY reason_count DESC, reason ASC
                ) AS rn
            FROM reason_counts
        )
        SELECT
            t.sku,
            t.return_count,
            rr.reason AS top_reason,
            rr.reason_count AS top_reason_count
        FROM sku_totals t
        LEFT JOIN ranked_reasons rr ON rr.sku = t.sku AND rr.rn = 1
        ORDER BY t.return_count DESC, t.sku ASC
        LIMIT %(top)s
    """
    rows = _fetch_all(
        conn,
        sql,
        {"account": account, "since": since, "until": until, "top": top},
    )
    return [
        {
            "sku": str(row.get("sku") or ""),
            "return_count": _int(row.get("return_count")),
            "top_reason": str(row.get("top_reason") or "UNKNOWN"),
            "top_reason_count": _int(row.get("top_reason_count")),
        }
        for row in rows
    ]


def fetch_sku_counts(
    conn: pymysql.Connection,
    account: str,
    skus: list[str],
    since: str,
    until: str,
) -> dict[str, int]:
    if not skus:
        return {}
    placeholders = ", ".join([f"%(sku{i})s" for i in range(len(skus))])
    params: dict[str, Any] = {"account": account, "since": since, "until": until}
    params.update({f"sku{i}": sku for i, sku in enumerate(skus)})
    sql = f"""
        SELECT r.seller_sku AS sku, COUNT(*) AS return_count
        FROM dws_od_amazon_refund_rate_d r
        WHERE r.check_date >= %(since)s
          AND r.check_date < %(until)s
          AND r.seller_sku IN ({placeholders})
          AND {_account_exists_clause("r")}
        GROUP BY r.seller_sku
    """
    return {
        str(row.get("sku") or ""): _int(row.get("return_count"))
        for row in _fetch_all(conn, sql, params)
    }


def fetch_ep_market_counts(
    conn: pymysql.Connection,
    since: str,
    until: str,
) -> dict[str, int]:
    sql = """
        SELECT d.Account AS account, COUNT(*) AS return_count
        FROM dws_od_amazon_refund_rate_d r
        INNER JOIN dm_allretrun_analysis_d d
            ON r.amazon_order_id = d.orderid
        WHERE d.Account LIKE 'AmazonEP%%'
          AND r.check_date >= %(since)s
          AND r.check_date < %(until)s
        GROUP BY d.Account
        ORDER BY d.Account ASC
    """
    return {
        str(row.get("account") or ""): _int(row.get("return_count"))
        for row in _fetch_all(conn, sql, {"since": since, "until": until})
    }


def build_other_market_rows(
    current: dict[str, int],
    previous: dict[str, int],
    exclude_account: str,
) -> list[dict[str, Any]]:
    accounts = sorted((set(current) | set(previous)) - {exclude_account})
    rows: list[dict[str, Any]] = []
    for account in accounts:
        curr = current.get(account, 0)
        prev = previous.get(account, 0)
        rows.append({
            "shop": account_to_shop(account),
            "current": curr,
            "previous": prev,
            "wow": format_wow(curr, prev),
            "flag": "⚠️" if is_spike(curr, prev) else "",
        })
    return rows


def percent(value: float, digits: int = 1) -> str:
    return f"{value * 100:.{digits}f}%"


def wow_ratio(current: float, previous: float) -> float | None:
    if previous == 0:
        if current == 0:
            return 0.0
        return None
    return (current - previous) / previous


def format_wow(current: float, previous: float) -> str:
    ratio = wow_ratio(current, previous)
    if ratio is None:
        return "↑ ∞%"
    if ratio > 0:
        return f"↑ {ratio * 100:.1f}%"
    if ratio < 0:
        return f"↓ {abs(ratio) * 100:.1f}%"
    return "→ 0.0%"


def is_spike(current: int, previous: int) -> bool:
    ratio = wow_ratio(current, previous)
    if ratio is None:
        return current > 0
    return ratio > 0.5


def reason_share_map(rows: list[dict[str, Any]]) -> dict[str, float]:
    total = sum(_int(row.get("return_count")) for row in rows)
    if total <= 0:
        return {}
    return {
        str(row.get("reason") or "UNKNOWN"): _int(row.get("return_count")) / total
        for row in rows
    }


def _md_cell(value: Any) -> str:
    text = str(value)
    return text.replace("\n", " ").replace("|", "\\|")


def render_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = [
        "| " + " | ".join(_md_cell(h) for h in headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    if rows:
        lines.extend("| " + " | ".join(_md_cell(c) for c in row) + " |" for row in rows)
    else:
        lines.append("| " + " | ".join(["-"] * len(headers)) + " |")
    return "\n".join(lines)


def render_status_table(data: ReportData) -> str:
    current = data.current_summary
    previous = data.previous_summary
    current_reason_shares = reason_share_map(data.current_reasons)
    previous_reason_shares = reason_share_map(data.previous_reasons)
    top_reason = data.current_reasons[0]["reason"] if data.current_reasons else "-"
    current_top_share = current_reason_shares.get(top_reason, 0.0)
    previous_top_share = previous_reason_shares.get(top_reason, 0.0)

    return render_table(
        ["指标", "本周", "上周", "WoW"],
        [
            [
                "总退货笔数",
                current["return_count"],
                previous["return_count"],
                format_wow(current["return_count"], previous["return_count"]),
            ],
            [
                "退货 SKU 数",
                current["sku_count"],
                previous["sku_count"],
                format_wow(current["sku_count"], previous["sku_count"]),
            ],
            [
                "Top reason 占比",
                f"{top_reason} {percent(current_top_share)}" if top_reason != "-" else "-",
                percent(previous_top_share) if top_reason != "-" else "-",
                format_wow(current_top_share, previous_top_share),
            ],
        ],
    )


def render_top_sku_table(rows: list[dict[str, Any]], previous_counts: dict[str, int]) -> str:
    table_rows: list[list[Any]] = []
    for row in rows:
        sku = str(row.get("sku") or "-")
        current_count = _int(row.get("return_count"))
        previous_count = previous_counts.get(sku, 0)
        table_rows.append([
            sku,
            current_count,
            f"{previous_count} ({format_wow(current_count, previous_count)})",
            row.get("top_reason") or "UNKNOWN",
        ])
    return render_table(["SKU", "退货数", "上周对比", "主要 reason"], table_rows)


def render_reason_table(current_rows: list[dict[str, Any]], previous_rows: list[dict[str, Any]]) -> str:
    current_shares = reason_share_map(current_rows)
    previous_shares = reason_share_map(previous_rows)
    table_rows: list[list[Any]] = []
    for row in current_rows[:5]:
        reason = str(row.get("reason") or "UNKNOWN")
        share = current_shares.get(reason, 0.0)
        previous_share = previous_shares.get(reason, 0.0)
        table_rows.append([
            reason,
            f"{percent(share)} ({_int(row.get('return_count'))})",
            format_wow(share, previous_share),
        ])
    return render_table(["reason", "占比", "WoW"], table_rows)


def render_other_market_table(rows: list[dict[str, Any]]) -> str:
    return render_table(
        ["市场", "本周", "上周", "WoW", "异常"],
        [
            [row["shop"], row["current"], row["previous"], row["wow"], row["flag"]]
            for row in rows
        ],
    )


def truncate_text(text: str, limit: int = 300) -> str:
    clean = " ".join(text.split())
    if len(clean) <= limit:
        return clean
    return clean[:limit].rstrip() + "..."


def render_markdown_report(data: ReportData) -> tuple[str, str]:
    title = f"{data.shop} 退货周报 {data.since} 至 {data.until}"
    complaint_section = ""
    if data.rag_answer:
        complaint_section = truncate_text(data.rag_answer)
    elif data.rag_warning:
        complaint_section = f"> 警告：{data.rag_warning}"
    else:
        complaint_section = "-"

    text = "\n\n".join([
        f"## {title}",
        "**现状**\n" + render_status_table(data),
        "**Top 5 退货 SKU**\n" + render_top_sku_table(data.top_skus, data.previous_sku_counts),
        "**Top 5 退货原因**\n" + render_reason_table(data.current_reasons, data.previous_reasons),
        "**客户语义抱怨**\n" + complaint_section,
        "**其他 EP 市场异常**\n" + render_other_market_table(data.other_market_rows),
    ])
    return title, text


def fetch_rag_complaint_summary(
    api_base: str,
    collection: str,
    shop: str,
    sku: str,
    timeout: float = 60.0,
) -> tuple[str | None, str | None]:
    query = (
        f"请总结 {shop} SKU {sku} 最近一周客户退货语义抱怨，"
        "重点关注尺码、面料、做工、颜色、描述不符和包装问题。"
    )
    payload = {
        "collection": collection,
        "query": query,
        "mode": "hybrid",
        "top_k": 8,
        "translate": "off",
    }
    try:
        with httpx.Client(timeout=timeout, trust_env=False) as client:
            response = client.post(f"{api_base.rstrip('/')}/search", json=payload)
            response.raise_for_status()
            answer = str(response.json().get("answer") or "").strip()
    except (httpx.HTTPError, ValueError) as exc:
        return None, f"RAG 服务不可达或查询失败，已跳过客户语义抱怨摘要：{exc}"
    if not answer:
        return None, "RAG 未返回可用摘要，已跳过客户语义抱怨摘要。"
    return answer, None


def build_report_data(
    conn: pymysql.Connection,
    shop: str,
    window: WeekWindow,
    rag_api_base: str,
    collection: str,
) -> ReportData:
    account = shop_to_account(shop)
    logger.info(
        "fetching weekly return report shop={} since={} until={} compare_since={}",
        shop,
        window.since,
        window.until,
        window.compare_since,
    )

    current_summary = fetch_summary(conn, account, window.since, window.until)
    previous_summary = fetch_summary(conn, account, window.compare_since, window.since)
    current_reasons = fetch_reason_counts(conn, account, window.since, window.until)
    previous_reasons = fetch_reason_counts(conn, account, window.compare_since, window.since)
    top_skus = fetch_top_skus(conn, account, window.since, window.until, top=5)
    previous_sku_counts = fetch_sku_counts(
        conn,
        account,
        [str(row["sku"]) for row in top_skus],
        window.compare_since,
        window.since,
    )
    current_markets = fetch_ep_market_counts(conn, window.since, window.until)
    previous_markets = fetch_ep_market_counts(conn, window.compare_since, window.since)
    other_market_rows = build_other_market_rows(current_markets, previous_markets, account)

    rag_answer: str | None = None
    rag_warning: str | None = None
    if top_skus:
        rag_answer, rag_warning = fetch_rag_complaint_summary(
            rag_api_base,
            collection,
            shop,
            str(top_skus[0]["sku"]),
        )
        if rag_warning:
            logger.warning("{}", rag_warning)

    return ReportData(
        shop=shop,
        since=window.since,
        until=window.until,
        compare_since=window.compare_since,
        current_summary=current_summary,
        previous_summary=previous_summary,
        current_reasons=current_reasons,
        previous_reasons=previous_reasons,
        top_skus=top_skus,
        previous_sku_counts=previous_sku_counts,
        other_market_rows=other_market_rows,
        rag_answer=rag_answer,
        rag_warning=rag_warning,
    )


def _iter_conversation_records(value: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                records.append(item)
    elif isinstance(value, dict):
        if any(key in value for key in ("openConversationId", "open_conversation_id", "conversationId", "id")):
            records.append(value)
        for key in ("conversations", "items", "groups", "data", "result"):
            records.extend(_iter_conversation_records(value.get(key)))
        for key, item in value.items():
            if isinstance(item, str):
                records.append({"name": key, "openConversationId": item})
            elif isinstance(item, dict):
                merged = {"name": key, **item} if "name" not in item else item
                records.extend(_iter_conversation_records(merged))
    return records


def lookup_open_conversation_id(path: Path, group_name: str) -> str:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise LookupError(f"conversation file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise LookupError(f"conversation file is invalid JSON: {path}: {exc}") from exc

    for record in _iter_conversation_records(payload):
        names = [
            record.get("name"),
            record.get("title"),
            record.get("groupName"),
            record.get("conversationName"),
            record.get("chatName"),
        ]
        if group_name not in {str(name) for name in names if name}:
            continue
        conversation_id = (
            record.get("openConversationId")
            or record.get("open_conversation_id")
            or record.get("conversationId")
            or record.get("id")
        )
        if conversation_id:
            return str(conversation_id)

    raise LookupError(f"group {group_name!r} not found in {path}")


class DingTalkClient:
    def __init__(
        self,
        app_key: str,
        app_secret: str,
        timeout: float = 15.0,
        client: httpx.Client | None = None,
    ) -> None:
        self.app_key = app_key
        self.app_secret = app_secret
        self.timeout = timeout
        self._client = client

    def _request_client(self) -> httpx.Client:
        if self._client is not None:
            return self._client
        return httpx.Client(timeout=self.timeout)

    def _get_access_token(self, client: httpx.Client) -> str:
        response = client.post(
            TOKEN_URL,
            json={"appKey": self.app_key, "appSecret": self.app_secret},
        )
        if response.status_code >= 300:
            raise RuntimeError(f"DingTalk token failed: {response.status_code} {response.text}")
        data = response.json()
        token = data.get("accessToken") or data.get("access_token")
        if not token:
            raise RuntimeError(f"DingTalk token response missing accessToken: {data}")
        return str(token)

    def send_markdown(self, open_conversation_id: str, title: str, text: str) -> dict[str, Any]:
        close_client = self._client is None
        client = self._request_client()
        try:
            access_token = self._get_access_token(client)
            body = {
                "openConversationId": open_conversation_id,
                "robotCode": self.app_key,
                "msgKey": "sampleMarkdown",
                "msgParam": json.dumps(
                    {"title": title, "text": text},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            }
            response = client.post(
                SEND_URL,
                headers={"x-acs-dingtalk-access-token": access_token},
                json=body,
            )
            if response.status_code >= 300:
                raise RuntimeError(f"DingTalk send failed: {response.status_code} {response.text}")
            data = response.json() if response.content else {}
            errcode = data.get("errcode")
            if errcode not in (None, 0, "0"):
                raise RuntimeError(f"DingTalk send failed: {data}")
            return data
        finally:
            if close_client:
                client.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", help="inclusive start date, YYYY-MM-DD")
    parser.add_argument("--until", help="exclusive end date, YYYY-MM-DD")
    parser.add_argument("--shop", default=DEFAULT_SHOP, help="shop code, default EP-US")
    parser.add_argument("--dry-run", action="store_true", help="print markdown only; do not push")
    parser.add_argument("--rag-api-base", default=DEFAULT_RAG_API_BASE)
    parser.add_argument("--collection", default=DEFAULT_COLLECTION)
    parser.add_argument("--group-name", default=DEFAULT_GROUP_NAME)
    parser.add_argument(
        "--conversations-file",
        default="~/.paperclip/dingtalk_conversations.json",
        help="JSON file containing DingTalk group openConversationId values",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        window = resolve_window(args.since, args.until)
        shop_to_account(args.shop)
    except (ValueError, argparse.ArgumentTypeError) as exc:
        logger.error("{}", exc)
        return 2

    try:
        conn = _connect()
    except Exception as exc:
        logger.error("DB connect failed: {}", exc)
        return 2

    try:
        data = build_report_data(
            conn,
            shop=args.shop,
            window=window,
            rag_api_base=args.rag_api_base,
            collection=args.collection,
        )
    except Exception as exc:
        logger.exception("weekly report build failed: {}", exc)
        return 1
    finally:
        conn.close()

    title, markdown = render_markdown_report(data)
    if args.dry_run:
        print(markdown)
        return 0

    conversations_path = Path(os.path.expanduser(args.conversations_file))
    try:
        open_conversation_id = lookup_open_conversation_id(conversations_path, args.group_name)
    except LookupError as exc:
        logger.error("DingTalk group lookup failed: {}", exc)
        return 1

    app_key = os.environ.get("DINGTALK_APP_KEY")
    app_secret = os.environ.get("DINGTALK_APP_SECRET")
    if not app_key or not app_secret:
        logger.error("missing DingTalk env vars: DINGTALK_APP_KEY and/or DINGTALK_APP_SECRET")
        return 2

    try:
        result = DingTalkClient(app_key, app_secret).send_markdown(
            open_conversation_id,
            title,
            markdown,
        )
    except Exception as exc:
        logger.error("DingTalk push failed: {}", exc)
        return 1

    logger.info("DingTalk weekly report sent: {}", result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
