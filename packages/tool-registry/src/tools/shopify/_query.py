#!/usr/bin/env python3
"""Shopify Admin API helper (subprocess contract v1, stdlib only)."""
from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit
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


def _next_page_info(link_header: str) -> str | None:
    """Parse the rel="next" cursor from a Shopify REST Link header."""
    if not link_header:
        return None
    for part in link_header.split(","):
        seg = part.strip()
        if 'rel="next"' not in seg:
            continue
        m = re.search(r"<([^>]+)>", seg)
        if not m:
            continue
        vals = parse_qs(urlsplit(m.group(1)).query).get("page_info")
        if vals:
            return vals[0]
    return None


def shopify_get_all(path: str, result_key: str, query: dict[str, Any] | None, max_items: int) -> list[dict[str, Any]]:
    """Cursor-paginate a Shopify REST list endpoint via the Link header, up to max_items.

    page_info cannot be combined with other filters (only limit), so the first
    page carries the caller's query and subsequent pages carry only limit+page_info.
    """
    shop = os.environ.get("SHOPIFY_SHOP")
    token = os.environ.get("SHOPIFY_TOKEN")
    api_version = os.environ.get("SHOPIFY_API_VERSION", "2024-10")
    if not shop or not token:
        emit({"error": "UpstreamError", "message": "missing SHOPIFY_SHOP or SHOPIFY_TOKEN env"}, 2)
    items: list[dict[str, Any]] = []
    query = {**(query or {})}
    query.setdefault("limit", 250)
    page_info: str | None = None
    for _page in range(40):  # hard cap: 40 * 250 = 10k items
        params = {"limit": query["limit"], "page_info": page_info} if page_info else query
        url = f"https://{shop}.myshopify.com/admin/api/{api_version}/{path}?{urlencode(params)}"
        req = Request(url, headers={"X-Shopify-Access-Token": token, "Accept": "application/json"})
        link = ""
        data: dict[str, Any] | None = None
        for attempt in range(2):
            try:
                with urlopen(req, timeout=20) as resp:
                    link = resp.headers.get("Link", "") or ""
                    data = json.loads(resp.read().decode("utf-8"))
                break
            except HTTPError as exc:
                if exc.code == 429 and attempt == 0:
                    time.sleep(retry_after_seconds(exc))
                    continue
                body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
                emit({"error": "UpstreamError", "message": f"HTTP {exc.code} {exc.reason}: {body[:500]}"}, 2)
            except URLError as exc:
                emit({"error": "UpstreamError", "message": f"URL error: {exc.reason}"}, 2)
        if data is None:
            emit({"error": "UpstreamError", "message": "Shopify request failed"}, 2)
        items.extend(data.get(result_key, []))
        if len(items) >= max_items:
            return items[:max_items]
        page_info = _next_page_info(link)
        if not page_info:
            break
    return items


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


def op_get_product_by_id(req: dict[str, Any]) -> None:
    product_id = req.get("productId")
    if not isinstance(product_id, str) or not product_id.isdigit():
        emit({"error": "ValidationError", "message": "getProductById requires numeric productId"}, 1)
    data = shopify_get(f"products/{product_id}.json")
    product = data.get("product")
    if not product:
        emit({"error": "NotFound", "message": f"no product with id '{product_id}'"}, 1)
    emit({"product": product})


def op_search_products(req: dict[str, Any]) -> None:
    limit = req.get("limit", 50)
    if not isinstance(limit, int) or limit < 1 or limit > 250:
        emit({"error": "ValidationError", "message": "limit must be 1..250"}, 1)
    query: dict[str, Any] = {"limit": limit}
    # REST products.json filters. NOTE: `title` is EXACT match (substring search needs GraphQL).
    status = req.get("status")
    if status is not None:
        if status not in ("active", "archived", "draft"):
            emit({"error": "ValidationError", "message": "status must be active/archived/draft"}, 1)
        query["status"] = status
    for key, param in (("vendor", "vendor"), ("productType", "product_type"),
                       ("collectionId", "collection_id"), ("title", "title")):
        val = req.get(key)
        if val is not None:
            if not isinstance(val, str) or not val:
                emit({"error": "ValidationError", "message": f"{key} must be a non-empty string"}, 1)
            query[param] = val
    data = shopify_get("products.json", query)
    emit({"products": data.get("products", [])})


def op_list_collections(req: dict[str, Any]) -> None:
    limit = req.get("limit", 50)
    if not isinstance(limit, int) or limit < 1 or limit > 250:
        emit({"error": "ValidationError", "message": "limit must be 1..250"}, 1)
    title_contains = req.get("titleContains")
    if title_contains is not None and not isinstance(title_contains, str):
        emit({"error": "ValidationError", "message": "titleContains must be a string"}, 1)
    needle = title_contains.lower() if isinstance(title_contains, str) and title_contains else None
    # REST has no unified collections endpoint — merge custom + smart. When a
    # title filter is set we must deep-scan (a store can have 1000+ smart
    # collections); paginate up to scan_cap per type so matches aren't silently
    # dropped past page 1. With no filter we just sample the first `limit` per type.
    scan_cap = 5000 if needle else limit
    collections: list[dict[str, Any]] = []
    for path, key, ctype in (("custom_collections.json", "custom_collections", "custom"),
                             ("smart_collections.json", "smart_collections", "smart")):
        matched = 0
        for col in shopify_get_all(path, key, {"limit": 250}, scan_cap):
            if not isinstance(col, dict):
                continue
            if needle and needle not in str(col.get("title", "")).lower():
                continue
            collections.append({
                "id": col.get("id"),
                "title": col.get("title"),
                "handle": col.get("handle"),
                "collectionType": ctype,
                "productsCount": col.get("products_count"),
                "updatedAt": col.get("updated_at"),
            })
            matched += 1
            if matched >= limit:
                break
    emit({"collections": collections})


def op_list_locations(req: dict[str, Any]) -> None:
    data = shopify_get("locations.json")
    emit({"locations": data.get("locations", [])})


def main() -> None:
    req = read_request()
    op = req.get("op")
    if op == "getProduct":
        op_get_product(req)
    elif op == "listProductsByCollection":
        op_list_products_by_collection(req)
    elif op == "getProductById":
        op_get_product_by_id(req)
    elif op == "searchProducts":
        op_search_products(req)
    elif op == "listCollections":
        op_list_collections(req)
    elif op == "listLocations":
        op_list_locations(req)
    else:
        emit({"error": "ValidationError", "message": f"unknown op: {op}"}, 1)


if __name__ == "__main__":
    main()
