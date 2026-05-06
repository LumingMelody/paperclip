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


def meta_get(path: str, query: dict[str, str]) -> dict[str, Any]:
    token = os.environ.get("META_ACCESS_TOKEN")
    api_version = os.environ.get("META_API_VERSION", "v20.0")
    if not token:
        emit({"error": "UpstreamError", "message": "missing META_ACCESS_TOKEN env"}, 2)
    merged = {**query, "access_token": token}
    url = f"https://graph.facebook.com/{api_version}/{path}?{urlencode(merged)}"
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


def normalize_account_id(raw: str) -> str:
    """Meta accepts either 'act_<id>' or '<id>'; normalize to act_ form."""
    raw = raw.strip()
    return raw if raw.startswith("act_") else f"act_{raw}"


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


def main() -> None:
    req = read_request()
    op = req.get("op")
    if op == "adAccountSummary":
        op_ad_account_summary(req)
    elif op == "adsetPerformance":
        op_adset_performance(req)
    else:
        emit({"error": "ValidationError", "message": f"unknown op: {op}"}, 1)


if __name__ == "__main__":
    main()
