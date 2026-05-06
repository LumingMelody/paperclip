#!/usr/bin/env python3
"""Amazon SP-API helper (subprocess contract v1, stdlib only).

Auth flow: LWA refresh-token → access_token (one POST per invocation).
Region endpoints: na | eu | fe → sellingpartnerapi-{region}.amazon.com.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROTOCOL_VERSION = "1"

REGION_HOSTS = {
    "na": "sellingpartnerapi-na.amazon.com",
    "eu": "sellingpartnerapi-eu.amazon.com",
    "fe": "sellingpartnerapi-fe.amazon.com",
}

LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"


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


def get_access_token() -> str:
    refresh = os.environ.get("SPAPI_REFRESH_TOKEN")
    cid = os.environ.get("SPAPI_CLIENT_ID")
    secret = os.environ.get("SPAPI_CLIENT_SECRET")
    if not refresh or not cid or not secret:
        emit(
            {
                "error": "UpstreamError",
                "message": "missing SPAPI_REFRESH_TOKEN / SPAPI_CLIENT_ID / SPAPI_CLIENT_SECRET env",
            },
            2,
        )
    body = urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": cid,
            "client_secret": secret,
        }
    ).encode("utf-8")
    req = Request(
        LWA_TOKEN_URL,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        emit({"error": "UpstreamError", "message": f"LWA token HTTP {e.code}: {body_text[:300]}"}, 2)
    except URLError as e:
        emit({"error": "UpstreamError", "message": f"LWA URL error: {e.reason}"}, 2)
    token = payload.get("access_token")
    if not token:
        emit({"error": "UpstreamError", "message": "LWA response missing access_token"}, 2)
    return token


def spapi_get(path: str, query: dict[str, str] | None = None) -> dict[str, Any]:
    region = os.environ.get("SPAPI_REGION", "na")
    host = REGION_HOSTS.get(region)
    if not host:
        emit({"error": "ValidationError", "message": f"unknown region: {region}"}, 1)
    token = get_access_token()
    qs = ("?" + urlencode(query)) if query else ""
    url = f"https://{host}{path}{qs}"
    req = Request(
        url,
        headers={
            "x-amz-access-token": token,
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        if e.code == 404:
            emit({"error": "NotFound", "message": f"{path}: {body_text[:200]}"}, 1)
        emit({"error": "UpstreamError", "message": f"HTTP {e.code}: {body_text[:500]}"}, 2)
    except URLError as e:
        emit({"error": "UpstreamError", "message": f"URL error: {e.reason}"}, 2)


def op_get_order(req: dict[str, Any]) -> None:
    order_id = req.get("orderId")
    if not isinstance(order_id, str) or not order_id:
        emit({"error": "ValidationError", "message": "getOrder requires orderId"}, 1)
    data = spapi_get(f"/orders/v0/orders/{order_id}")
    payload = data.get("payload")
    if not payload:
        emit({"error": "NotFound", "message": f"no order with id '{order_id}'"}, 1)
    emit({"order": payload})


def op_list_orders_updated_since(req: dict[str, Any]) -> None:
    since = req.get("since")
    marketplace_id = req.get("marketplaceId")
    max_results = req.get("maxResults", 100)
    if not isinstance(since, str) or not since:
        emit({"error": "ValidationError", "message": "listOrdersUpdatedSince requires since (ISO 8601)"}, 1)
    if not isinstance(marketplace_id, str) or not marketplace_id:
        # fall back to default from secrets env
        marketplace_id = os.environ.get("SPAPI_MARKETPLACE_ID", "")
        if not marketplace_id:
            emit(
                {"error": "ValidationError", "message": "listOrdersUpdatedSince requires marketplaceId"},
                1,
            )
    if not isinstance(max_results, int) or max_results < 1 or max_results > 100:
        emit({"error": "ValidationError", "message": "maxResults must be 1..100"}, 1)
    query = {
        "MarketplaceIds": marketplace_id,
        "LastUpdatedAfter": since,
        "MaxResultsPerPage": str(max_results),
    }
    data = spapi_get("/orders/v0/orders", query)
    payload = data.get("payload", {})
    orders = payload.get("Orders", [])
    if not isinstance(orders, list):
        emit({"error": "UpstreamError", "message": "unexpected orders response shape"}, 2)
    emit({"orders": orders, "nextToken": payload.get("NextToken")})


def main() -> None:
    req = read_request()
    op = req.get("op")
    if op == "getOrder":
        op_get_order(req)
    elif op == "listOrdersUpdatedSince":
        op_list_orders_updated_since(req)
    else:
        emit({"error": "ValidationError", "message": f"unknown op: {op}"}, 1)


if __name__ == "__main__":
    main()
