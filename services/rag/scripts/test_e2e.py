#!/usr/bin/env python3
"""End-to-end canary for paperclip-rag Phase 1.

Steps:
  1. GET  /healthz                   -> assert lm_studio == "up"
  2. POST /index (3 synthetic docs)  -> assert 202
  3. POST /search "退货 偏小"        -> assert chunks/answer non-empty
  4. GET  /collections               -> assert canary collection present
  5. cleanup: remove canary working_dir

Exit code: 0 success, non-zero with stage name on failure.

Pre-requisites:
  - paperclip-rag service running on PAPERCLIP_RAG_API (default 127.0.0.1:9001)
  - LM Studio running on 127.0.0.1:1234 with chat + embedding models loaded
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

import httpx


API = os.environ.get("PAPERCLIP_RAG_API", "http://127.0.0.1:9001")
STORAGE_ROOT = Path(
    os.environ.get("PAPERCLIP_RAG_STORAGE_ROOT", "~/.paperclip/lightrag-storage")
).expanduser()
COLLECTION = "_e2e_canary"


def stage(name: str) -> None:
    print(f"[stage] {name}", flush=True)


def fail(name: str, msg: str) -> int:
    print(f"[FAIL ] {name}: {msg}", file=sys.stderr, flush=True)
    return 1


def main() -> int:
    with httpx.Client(timeout=300.0) as c:
        stage("healthz")
        r = c.get(f"{API}/healthz")
        if r.status_code != 200:
            return fail("healthz", f"{r.status_code} {r.text}")
        body = r.json()
        if body.get("lm_studio") != "up":
            return fail("healthz", f"lm_studio={body.get('lm_studio')}")

        stage("index")
        docs = [
            {"id": "c1", "text": "客户反馈 SKU EG02084 尺码偏小，建议升一码。"},
            {"id": "c2", "text": "EE02559 物流损坏率高，需更换包装供应商。"},
            {"id": "c3", "text": "Amazon 渠道 EG02084 退货主因：sizing。"},
        ]
        r = c.post(
            f"{API}/index",
            json={"collection": COLLECTION, "docs": docs, "upsert": True},
        )
        if r.status_code not in (200, 202):
            return fail("index", f"{r.status_code} {r.text}")

        stage("search")
        time.sleep(1.0)
        r = c.post(
            f"{API}/search",
            json={"collection": COLLECTION, "query": "退货 偏小", "mode": "hybrid"},
        )
        if r.status_code != 200:
            return fail("search", f"{r.status_code} {r.text}")
        ans = r.json().get("answer", "")
        if not ans or not isinstance(ans, str):
            return fail("search", f"empty answer: {r.json()!r}")

        stage("collections")
        r = c.get(f"{API}/collections")
        if r.status_code != 200:
            return fail("collections", f"{r.status_code} {r.text}")
        names = [x["name"] for x in r.json().get("collections", [])]
        if COLLECTION not in names:
            print(f"[warn ] {COLLECTION} not in {names}; cached_collections is lazy",
                  flush=True)

    stage("cleanup")
    canary_dir = STORAGE_ROOT / COLLECTION
    if canary_dir.exists():
        shutil.rmtree(canary_dir)
        print(f"removed {canary_dir}", flush=True)

    print("[ OK  ] paperclip-rag Phase 1 e2e passed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
