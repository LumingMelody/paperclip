#!/usr/bin/env python3
"""Shopify Admin API helper (subprocess contract v1, stdlib only)."""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
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
        emit({"error": "ValidationError", "message": f"unsupported version: {req.get('version')}"}, 1)
    return req


def retry_after_seconds(error: HTTPError) -> float:
    retry_after = error.headers.get("Retry-After")
    if retry_after:
        try:
            return max(float(retry_after), 0.0)
        except ValueError:
            return 1.0
    return 1.0


def shopify_get(path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
    shop = os.environ.get("SHOPIFY_SHOP")
    token = os.environ.get("SHOPIFY_TOKEN")
    api_version = os.environ.get("SHOPIFY_API_VERSION", "2024-10")
    if not shop or not token:
        emit({"error": "UpstreamError", "message": "missing SHOPIFY_SHOP or SHOPIFY_TOKEN env"}, 2)
    qs = ("?" + urlencode(query)) if query else ""
    url = f"https://{shop}.myshopify.com/admin/api/{api_version}/{path}{qs}"
    req = Request(url, headers={"X-Shopify-Access-Token": token, "Accept": "application/json"})
    for attempt in range(2):
        try:
            with urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code == 429 and attempt == 0:
                time.sleep(retry_after_seconds(exc))
                continue
            body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            emit({"error": "UpstreamError", "message": f"HTTP {exc.code} {exc.reason}: {body[:500]}"}, 2)
        except URLError as exc:
            emit({"error": "UpstreamError", "message": f"URL error: {exc.reason}"}, 2)
    emit({"error": "UpstreamError", "message": "Shopify request failed"}, 2)


def op_get_product(req: dict[str, Any]) -> None:
    handle = req.get("handle")
    if not isinstance(handle, str) or not handle:
        emit({"error": "ValidationError", "message": "getProduct requires handle"}, 1)
    data = shopify_get("products.json", {"handle": handle})
    products = data.get("products", [])
    product = next((item for item in products if isinstance(item, dict) and item.get("handle") == handle), None)
    if not product:
        emit({"error": "NotFound", "message": f"no product with handle '{handle}'"}, 1)
    emit({"product": product})


def op_list_products_by_collection(req: dict[str, Any]) -> None:
    collection_id = req.get("collectionId")
    limit = req.get("limit", 50)
    if not isinstance(collection_id, str) or not collection_id:
        emit({"error": "ValidationError", "message": "listProductsByCollection requires collectionId"}, 1)
    if not isinstance(limit, int) or limit < 1 or limit > 250:
        emit({"error": "ValidationError", "message": "limit must be 1..250"}, 1)
    data = shopify_get(f"collections/{quote(collection_id, safe='')}/products.json", {"limit": limit})
    emit({"products": data.get("products", [])})


def main() -> None:
    req = read_request()
    op = req.get("op")
    if op == "getProduct":
        op_get_product(req)
    elif op == "listProductsByCollection":
        op_list_products_by_collection(req)
    else:
        emit({"error": "ValidationError", "message": f"unknown op: {op}"}, 1)


if __name__ == "__main__":
    main()
