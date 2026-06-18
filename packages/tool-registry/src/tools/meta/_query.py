#!/usr/bin/env python3
"""Meta Marketing API helper (subprocess contract v1, stdlib only)."""
from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROTOCOL_VERSION = "1"


def emit(payload: dict[str, Any], code: int = 0) -> None:
    payload.setdefault("version", PROTOCOL_VERSION)
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def read_request() -> dict[str, Any]:
    try:
        req = json.loads(sys.stdin.read())
    except Exception as exc:
        emit({"error": "ValidationError", "message": f"invalid JSON: {exc}"}, 1)
    if not isinstance(req, dict):
        emit({"error": "ValidationError", "message": "request must be object"}, 1)
    if req.get("version") != PROTOCOL_VERSION:
        emit(
            {"error": "ValidationError", "message": f"unsupported version: {req.get('version')}"},
            1,
        )
    return req


def meta_request_json(url: str) -> dict[str, Any]:
    req = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        emit(
            {"error": "UpstreamError", "message": f"HTTP {e.code} {e.reason}: {body[:500]}"},
            2,
        )
    except URLError as e:
        emit({"error": "UpstreamError", "message": f"URL error: {e.reason}"}, 2)


def meta_url(path: str, query: dict[str, str]) -> str:
    token = os.environ.get("META_ACCESS_TOKEN")
    api_version = os.environ.get("META_API_VERSION", "v20.0")
    if not token:
        emit({"error": "UpstreamError", "message": "missing META_ACCESS_TOKEN env"}, 2)
    merged = {**query, "access_token": token}
    return f"https://graph.facebook.com/{api_version}/{path}?{urlencode(merged)}"


def meta_get(path: str, query: dict[str, str]) -> dict[str, Any]:
    return meta_request_json(meta_url(path, query))


def meta_get_paginated(
    path: str,
    query: dict[str, str],
    row_limit: int = 5000,
    page_limit: int = 50,
) -> list[Any]:
    url = meta_url(path, query)
    rows: list[Any] = []
    pages = 0
    while url and pages < page_limit and len(rows) < row_limit:
        data = meta_request_json(url)
        page_rows = data.get("data", [])
        if not isinstance(page_rows, list):
            emit({"error": "UpstreamError", "message": "unexpected paginated response shape"}, 2)
        remaining = row_limit - len(rows)
        rows.extend(page_rows[:remaining])
        pages += 1
        paging = data.get("paging", {})
        next_url = paging.get("next") if isinstance(paging, dict) else None
        url = next_url if isinstance(next_url, str) and next_url else None
    return rows


def normalize_account_id(raw: str) -> str:
    """Meta accepts either 'act_<id>' or '<id>'; normalize to act_ form."""
    raw = raw.strip()
    return raw if raw.startswith("act_") else f"act_{raw}"


def unique_csv(values: list[str]) -> str:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ",".join(ordered)


def op_ad_account_summary(req: dict[str, Any]) -> None:
    account_id = req.get("accountId")
    if not isinstance(account_id, str) or not account_id:
        emit({"error": "ValidationError", "message": "adAccountSummary requires accountId"}, 1)
    norm = normalize_account_id(account_id)
    fields = "name,account_status,currency,timezone_name,amount_spent,balance,business_country_code"
    data = meta_get(norm, {"fields": fields})
    emit({"account": data})


def op_adset_performance(req: dict[str, Any]) -> None:
    account_id = req.get("accountId")
    since = req.get("since")
    until = req.get("until")
    if not isinstance(account_id, str) or not account_id:
        emit({"error": "ValidationError", "message": "adsetPerformance requires accountId"}, 1)
    if not isinstance(since, str) or not isinstance(until, str):
        emit(
            {"error": "ValidationError", "message": "adsetPerformance requires since and until (YYYY-MM-DD)"},
            1,
        )
    norm = normalize_account_id(account_id)
    time_range = json.dumps({"since": since, "until": until})
    fields = "adset_id,adset_name,campaign_name,spend,impressions,inline_link_clicks,purchase_roas,actions"
    query = {
        "level": "adset",
        "fields": fields,
        "time_range": time_range,
        "limit": "500",
    }
    data = meta_get(f"{norm}/insights", query)
    rows = data.get("data", [])
    if not isinstance(rows, list):
        emit({"error": "UpstreamError", "message": "unexpected insights response shape"}, 2)
    emit({"rows": rows})


def op_insights(req: dict[str, Any]) -> None:
    account_id = req.get("accountId")
    since = req.get("since")
    until = req.get("until")
    level = req.get("level", "account")
    breakdowns = req.get("breakdowns")
    time_increment = req.get("timeIncrement", "all_days")
    if not isinstance(account_id, str) or not account_id:
        emit({"error": "ValidationError", "message": "insights requires accountId"}, 1)
    if not isinstance(since, str) or not isinstance(until, str):
        emit({"error": "ValidationError", "message": "insights requires since and until (YYYY-MM-DD)"}, 1)
    if level not in ("account", "campaign", "adset", "ad"):
        emit({"error": "ValidationError", "message": "invalid insights level"}, 1)
    if time_increment not in ("all_days", "1"):
        emit({"error": "ValidationError", "message": "invalid insights timeIncrement"}, 1)
    if breakdowns is not None and (
        not isinstance(breakdowns, list) or not all(isinstance(item, str) for item in breakdowns)
    ):
        emit({"error": "ValidationError", "message": "insights breakdowns must be a string array"}, 1)

    norm = normalize_account_id(account_id)
    time_range = json.dumps({"since": since, "until": until})
    fields = unique_csv(
        [
            "spend",
            "impressions",
            "inline_link_clicks",
            "purchase_roas",
            "actions",
            "campaign_name",
            f"{level}_id",
            f"{level}_name",
        ]
    )
    query = {
        "level": level,
        "fields": fields,
        "time_range": time_range,
        "limit": "500",
    }
    if isinstance(breakdowns, list) and len(breakdowns) > 0:
        query["breakdowns"] = ",".join(breakdowns)
    if time_increment == "1":
        query["time_increment"] = "1"

    should_paginate = (isinstance(breakdowns, list) and len(breakdowns) > 0) or time_increment == "1"
    if should_paginate:
        rows = meta_get_paginated(f"{norm}/insights", query)
    else:
        data = meta_get(f"{norm}/insights", query)
        rows = data.get("data", [])
        if not isinstance(rows, list):
            emit({"error": "UpstreamError", "message": "unexpected insights response shape"}, 2)
    emit({"rows": rows})


def op_list_campaigns(req: dict[str, Any]) -> None:
    account_id = req.get("accountId")
    effective_status = req.get("effectiveStatus")
    limit = req.get("limit")
    if not isinstance(account_id, str) or not account_id:
        emit({"error": "ValidationError", "message": "listCampaigns requires accountId"}, 1)
    if effective_status is not None and (
        not isinstance(effective_status, list) or not all(isinstance(item, str) for item in effective_status)
    ):
        emit({"error": "ValidationError", "message": "listCampaigns effectiveStatus must be a string array"}, 1)
    if limit is not None and not isinstance(limit, int):
        emit({"error": "ValidationError", "message": "listCampaigns limit must be an integer"}, 1)

    norm = normalize_account_id(account_id)
    fields = "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time"
    query = {
        "fields": fields,
        "limit": str(limit if isinstance(limit, int) else 500),
    }
    if isinstance(effective_status, list):
        query["effective_status"] = json.dumps(effective_status)
    campaigns = meta_get_paginated(f"{norm}/campaigns", query)
    emit({"campaigns": campaigns})


def op_list_ads(req: dict[str, Any]) -> None:
    account_id = req.get("accountId")
    campaign_id = req.get("campaignId")
    effective_status = req.get("effectiveStatus")
    if not isinstance(account_id, str) or not account_id:
        emit({"error": "ValidationError", "message": "listAds requires accountId"}, 1)
    if campaign_id is not None and not isinstance(campaign_id, str):
        emit({"error": "ValidationError", "message": "listAds campaignId must be a string"}, 1)
    if effective_status is not None and (
        not isinstance(effective_status, list) or not all(isinstance(item, str) for item in effective_status)
    ):
        emit({"error": "ValidationError", "message": "listAds effectiveStatus must be a string array"}, 1)

    norm = normalize_account_id(account_id)
    fields = "id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url,title,body,object_story_spec}"
    query = {
        "fields": fields,
        "limit": "500",
    }
    if isinstance(effective_status, list):
        query["effective_status"] = json.dumps(effective_status)
    if isinstance(campaign_id, str) and campaign_id:
        query["filtering"] = json.dumps([{"field": "campaign.id", "operator": "EQUAL", "value": campaign_id}])
    ads = meta_get_paginated(f"{norm}/ads", query)
    emit({"ads": ads})


def main() -> None:
    req = read_request()
    op = req.get("op")
    if op == "adAccountSummary":
        op_ad_account_summary(req)
    elif op == "adsetPerformance":
        op_adset_performance(req)
    elif op == "insights":
        op_insights(req)
    elif op == "listCampaigns":
        op_list_campaigns(req)
    elif op == "listAds":
        op_list_ads(req)
    else:
        emit({"error": "ValidationError", "message": f"unknown op: {op}"}, 1)


if __name__ == "__main__":
    main()
