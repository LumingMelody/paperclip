# B2 — RAG 多账号 ingest + file_path/references 修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 paperclip-rag 的 `refund_comments` collection 从 EP-US 单账号扩到 EP 全市场，并在 ingest 时正确落地 `file_path`，让钉钉机器人回答附上真实可核对的来源。

**Architecture:** 单一共享 collection（跨市场 KG）。新增多账号编排脚本逐账号灌数；修复 `/index` 端点透传 `file_path` 给 LightRAG（根因）；B1 工具改 `shop` 可选并把来源段拼进 `answer`。Rollout 走旁路新建 `refund_comments_v2` + 原子 rename 切换，零停机。

**Tech Stack:** Python 3.13 / FastAPI / LightRAG 1.4.16 / pymysql（services/rag）；TypeScript / zod / vitest（packages/tool-registry）。

**Spec:** `docs/superpowers/specs/2026-05-20-rag-multi-account-ingest-design.md`

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `services/rag/src/paperclip_rag/schemas.py` | HTTP 模型 | `IndexDoc` 加 `file_path` 字段 |
| `services/rag/src/paperclip_rag/api.py` | FastAPI 路由 | `/index` 把 `file_paths=` 传给 `ainsert` |
| `services/rag/src/paperclip_rag/ingest/refund_comments.py` | 单账号 ingest + 可复用函数 | 重构出 `account_to_shop` / `build_docs` / `filter_new` / `post_docs` / `record_manifest`；doc 带 `file_path`、id 加 shop 前缀 |
| `services/rag/src/paperclip_rag/ingest/refund_comments_all.py` | 多账号编排 | 新增——account 发现 + 逐账号循环 |
| `services/rag/tests/test_api.py` | API 测试 | 加 `/index` file_path 透传测试 |
| `services/rag/tests/test_ingest_refund_comments.py` | 单账号 ingest 测试 | 新增 |
| `services/rag/tests/test_ingest_refund_comments_all.py` | 编排测试 | 新增 |
| `packages/tool-registry/src/tools/rag/client.ts` | RAG HTTP 客户端 | `RagSearchOk` 加 `references` |
| `packages/tool-registry/src/tools/rag/searchRefundComments.ts` | B1 工具 | `shop` 可选、来源拼进 answer、description 更新 |
| `packages/tool-registry/src/tools/rag/searchRefundComments.test.ts` | B1 工具测试 | 更新 + 新增 |

**线格式约定（贯穿全计划）：**
- doc `id` = `{shop}::{orderId}::{sku}`，例 `EP-UK::302-1234567-1234567::EE02968`
- doc `file_path` = `{shop}/{sku}/{orderId}`，例 `EP-UK/EE02968/302-1234567-1234567`
- `orderId` / `sku` 为空时该段填 `unknown`
- account → shop：`EverPretty-UK` → `EP-UK`
- RAG `/search` 返回的 references 是 **snake_case** wire 格式：`{reference_id, file_path}`（已由 `services/rag/tests/test_api.py:339-350` 证实）。B1 outputSchema 因此用 snake_case，不要用 camelCase。

---

## Task 1: `/index` 透传 file_path（根因修复）

**Files:**
- Modify: `services/rag/src/paperclip_rag/schemas.py` (IndexDoc class, 约 line 18-22)
- Modify: `services/rag/src/paperclip_rag/api.py` (index handler, 约 line 114-124)
- Test: `services/rag/tests/test_api.py`

- [ ] **Step 1: 写失败测试**

加到 `services/rag/tests/test_api.py` 末尾：

```python
def test_index_passes_file_paths_to_ainsert(app_and_rag):
    app, rag = app_and_rag
    payload = {
        "collection": "refund_comments",
        "docs": [
            {"id": "EP-UK::ord1::EE02968", "text": "comment one",
             "file_path": "EP-UK/EE02968/ord1"},
            {"id": "EP-DE::ord2::EG01923", "text": "comment two",
             "file_path": "EP-DE/EG01923/ord2"},
        ],
    }
    with TestClient(app) as c:
        r = c.post("/index", json=payload)
    assert r.status_code == 202
    _args, kwargs = rag.ainsert.call_args
    assert kwargs["file_paths"] == ["EP-UK/EE02968/ord1", "EP-DE/EG01923/ord2"]
    assert kwargs["ids"] == ["EP-UK::ord1::EE02968", "EP-DE::ord2::EG01923"]


def test_index_file_path_falls_back_to_id(app_and_rag):
    app, rag = app_and_rag
    payload = {
        "collection": "decisions",
        "docs": [{"id": "d1", "text": "no file_path provided"}],
    }
    with TestClient(app) as c:
        r = c.post("/index", json=payload)
    assert r.status_code == 202
    _args, kwargs = rag.ainsert.call_args
    assert kwargs["file_paths"] == ["d1"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/rag && uv run pytest tests/test_api.py::test_index_passes_file_paths_to_ainsert tests/test_api.py::test_index_file_path_falls_back_to_id -v`
Expected: FAIL — `ainsert` 当前不带 `file_paths` kwarg，`kwargs["file_paths"]` 抛 KeyError。

- [ ] **Step 3: schemas.py 加字段**

`services/rag/src/paperclip_rag/schemas.py`，`IndexDoc` 改为：

```python
class IndexDoc(BaseModel):
    id: str
    text: str
    file_path: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
```

- [ ] **Step 4: api.py index handler 透传 file_paths**

`services/rag/src/paperclip_rag/api.py` 的 `index` 函数体改为：

```python
    @app.post("/index", status_code=202, response_model=IndexResponse)
    async def index(req: IndexRequest) -> IndexResponse:
        rag = await factory.get(req.collection)
        texts = [d.text for d in req.docs]
        ids = [d.id for d in req.docs]
        # file_path drives LightRAG's reference list; fall back to id so a
        # chunk is never the useless "unknown_source" default.
        file_paths = [d.file_path or d.id for d in req.docs]
        try:
            await rag.ainsert(texts, ids=ids, file_paths=file_paths)
        except LMStudioUnavailable as e:
            raise HTTPException(503, {"error": {"code": "lm_studio_down", "message": str(e)}})
        return IndexResponse(indexed=len(req.docs), skipped=0)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd services/rag && uv run pytest tests/test_api.py -v`
Expected: PASS（含两个新测试 + 原有 `test_index_small_batch_calls_ainsert` 等全绿）。

- [ ] **Step 6: Commit**

```bash
git add services/rag/src/paperclip_rag/schemas.py services/rag/src/paperclip_rag/api.py services/rag/tests/test_api.py
git commit -m "fix(rag,b2): /index forwards file_path to LightRAG ainsert

Root cause of empty references: ainsert was called without file_paths=,
so every chunk became unknown_source. IndexDoc gains an optional file_path
field; /index passes it through (falling back to doc id).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `refund_comments.py` 重构 — 可复用函数 + file_path + shop 前缀 id

**Files:**
- Modify: `services/rag/src/paperclip_rag/ingest/refund_comments.py`
- Test: `services/rag/tests/test_ingest_refund_comments.py` (Create)

**背景:** 当前 `refund_comments.py` 的 doc 构建、manifest 过滤、HTTP POST 全内联在 `main()` 里。本任务抽成可被编排脚本（Task 3）复用的纯函数，并把 file_path / shop 前缀 id 加进去。`main()` 的单账号 CLI 行为保持向后兼容。

- [ ] **Step 1: 写失败测试**

Create `services/rag/tests/test_ingest_refund_comments.py`：

```python
import pytest

from paperclip_rag.ingest.refund_comments import (
    account_to_shop,
    build_docs,
    filter_new,
)


def test_account_to_shop_strips_everpretty_prefix():
    assert account_to_shop("EverPretty-US") == "EP-US"
    assert account_to_shop("EverPretty-UK") == "EP-UK"
    assert account_to_shop("EverPretty-DE") == "EP-DE"


def test_account_to_shop_rejects_unknown_format():
    with pytest.raises(ValueError):
        account_to_shop("AmazonEPUS")


def test_build_docs_sets_shop_prefixed_id_and_file_path():
    rows = [{
        "customerComment": "dress runs small",
        "sellerSku": "EE02968",
        "styleCode": "EE02968",
        "size": "M",
        "color": "Red",
        "returnReason": "TOO_SMALL",
        "quantity": 1,
        "orderId": "302-111-222",
    }]
    docs = build_docs(rows, "EP-UK")
    assert len(docs) == 1
    d = docs[0]
    assert d["id"] == "EP-UK::302-111-222::EE02968"
    assert d["file_path"] == "EP-UK/EE02968/302-111-222"
    assert d["metadata"]["shop"] == "EP-UK"
    assert d["metadata"]["sellerSku"] == "EE02968"
    assert "_sha" in d["metadata"]
    assert d["text"].startswith("customer_comment: dress runs small")


def test_build_docs_fills_unknown_for_missing_order_and_sku():
    rows = [{"customerComment": "no ids on this row"}]
    docs = build_docs(rows, "EP-FR")
    assert docs[0]["file_path"] == "EP-FR/unknown/unknown"
    assert docs[0]["id"].startswith("EP-FR::")


class _FakeManifest:
    def __init__(self, seen_pairs):
        self._seen = set(seen_pairs)

    def seen(self, source_id, content_sha256):
        return (source_id, content_sha256) in self._seen


def test_filter_new_drops_manifest_seen_and_dup_ids():
    docs = [
        {"id": "EP-UK::a::s1", "text": "t1", "file_path": "fp1",
         "metadata": {"_sha": "sha1"}},
        {"id": "EP-UK::a::s1", "text": "t1", "file_path": "fp1",
         "metadata": {"_sha": "sha1"}},  # within-batch dup id
        {"id": "EP-UK::b::s2", "text": "t2", "file_path": "fp2",
         "metadata": {"_sha": "sha2"}},
    ]
    manifest = _FakeManifest({("EP-UK::b::s2", "sha2")})  # b already ingested
    kept, skipped, deduped = filter_new(docs, manifest, force=False)
    assert [d["id"] for d in kept] == ["EP-UK::a::s1"]
    assert skipped == 1
    assert deduped == 1


def test_filter_new_force_bypasses_manifest():
    docs = [{"id": "EP-UK::b::s2", "text": "t2", "file_path": "fp2",
             "metadata": {"_sha": "sha2"}}]
    manifest = _FakeManifest({("EP-UK::b::s2", "sha2")})
    kept, skipped, deduped = filter_new(docs, manifest, force=True)
    assert [d["id"] for d in kept] == ["EP-UK::b::s2"]
    assert skipped == 0
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/rag && uv run pytest tests/test_ingest_refund_comments.py -v`
Expected: FAIL — `ImportError: cannot import name 'account_to_shop'`（函数还不存在）。

- [ ] **Step 3: 重构 refund_comments.py**

`services/rag/src/paperclip_rag/ingest/refund_comments.py`：

(a) 在 `_row_to_text` 之后、`_row_id` 之前加新函数 `account_to_shop`：

```python
def account_to_shop(account: str) -> str:
    """`EverPretty-US` -> `EP-US`. Raises ValueError on any other format."""
    if not account.startswith("EverPretty-"):
        raise ValueError(f"account must look like EverPretty-XX, got {account!r}")
    country = account.split("-", 1)[1]
    if not country:
        raise ValueError(f"account missing country suffix: {account!r}")
    return f"EP-{country}"
```

(b) 把现有 `_row_id` 替换为接受 `shop` 的版本，并新增 `_row_file_path`：

```python
def _row_id(r: dict[str, Any], shop: str) -> str:
    """Source ID = shop::order_id::seller_sku, stable across re-runs.

    The shop prefix prevents the same orderId/sku colliding across markets
    in the shared collection.
    """
    oid = str(r.get("orderId") or "")
    sku = str(r.get("sellerSku") or "")
    if not oid and not sku:
        return f"{shop}::row:{hash(json.dumps(r, default=str)) & 0xFFFFFFFF:x}"
    return f"{shop}::{oid}::{sku}"


def _row_file_path(r: dict[str, Any], shop: str) -> str:
    """file_path = shop/sku/orderId — drives LightRAG's reference list and is
    parsed back into '站点 / SKU / 订单' by the B1 tool."""
    oid = str(r.get("orderId") or "") or "unknown"
    sku = str(r.get("sellerSku") or "") or "unknown"
    return f"{shop}/{sku}/{oid}"
```

(c) 新增 `build_docs`（纯函数，rows → doc dicts）：

```python
def build_docs(rows: list[dict[str, Any]], shop: str) -> list[dict[str, Any]]:
    """Transform DWS refund rows into LightRAG index docs for one shop.

    Pure: no DB, no manifest, no HTTP. Manifest/dup filtering is filter_new's job.
    """
    docs: list[dict[str, Any]] = []
    for r in rows:
        text = _row_to_text(r)
        docs.append({
            "id": _row_id(r, shop),
            "text": text,
            "file_path": _row_file_path(r, shop),
            "metadata": {
                "source": "dws_od_amazon_refund_rate_d",
                "shop": shop,
                "sellerSku": r.get("sellerSku"),
                "styleCode": r.get("styleCode"),
                "eventDate": str(r.get("eventDate") or ""),
                "returnReason": r.get("returnReason"),
                "orderId": r.get("orderId"),
                "_sha": _content_sha(text),
            },
        })
    return docs
```

(d) 新增 `filter_new`（manifest + 批内去重）：

```python
def filter_new(
    docs: list[dict[str, Any]],
    manifest: IngestManifest,
    force: bool,
) -> tuple[list[dict[str, Any]], int, int]:
    """Drop docs already in the manifest and within-batch duplicate ids.

    Returns (kept_docs, manifest_skipped, dup_id_deduped).
    """
    kept: list[dict[str, Any]] = []
    skipped = 0
    deduped = 0
    seen_ids: set[str] = set()
    for d in docs:
        sid = d["id"]
        sha = d["metadata"]["_sha"]
        if not force and manifest.seen(sid, sha):
            skipped += 1
            continue
        if sid in seen_ids:
            deduped += 1
            continue
        seen_ids.add(sid)
        kept.append(d)
    return kept, skipped, deduped
```

(e) 新增 `post_docs` 和 `record_manifest`：

```python
def post_docs(
    api_base: str,
    collection: str,
    docs: list[dict[str, Any]],
    timeout: float = 14400.0,
) -> dict[str, Any]:
    """POST docs to the RAG /index endpoint. Raises on HTTP >= 300.

    The 4h timeout matches synchronous LightRAG ingest of large batches —
    a premature ReadTimeout would leave the manifest unwritten.
    """
    payload = {"collection": collection, "docs": docs, "upsert": True}
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(f"{api_base}/index", json=payload)
    if resp.status_code >= 300:
        raise RuntimeError(f"ingest failed: {resp.status_code} {resp.text}")
    return resp.json()


def record_manifest(manifest: IngestManifest, docs: list[dict[str, Any]]) -> None:
    for d in docs:
        manifest.record(d["id"], d["metadata"]["_sha"], chunk_count=1)
```

(f) 改写 `main()` 用上面的函数组合（替换原 `main()` 整个函数体）：

```python
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="ISO date, e.g. 2026-01-01")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--sku-prefix", default=None)
    parser.add_argument("--account", default=os.environ.get("PAPERCLIP_RAG_INGEST_ACCOUNT"))
    parser.add_argument("--api-base", default="http://127.0.0.1:9001")
    parser.add_argument("--collection", default="refund_comments")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="bypass manifest skip")
    args = parser.parse_args(argv)

    if not args.account:
        logger.error("--account is required (or set PAPERCLIP_RAG_INGEST_ACCOUNT)")
        return 2
    try:
        shop = account_to_shop(args.account)
    except ValueError as e:
        logger.error("{}", e)
        return 2

    logger.info("connecting to MySQL")
    try:
        conn = _connect()
    except Exception as e:
        logger.error("DB connect failed: {}", e)
        return 2
    try:
        rows = _fetch_rows(
            conn,
            account=args.account,
            since=args.since,
            sku_prefix=args.sku_prefix,
            limit=args.limit,
        )
    finally:
        conn.close()

    logger.info("fetched {} rows", len(rows))
    if not rows:
        return 0

    settings = get_settings()
    manifest_path = settings.collection_dir(args.collection) / "_manifest.jsonl"
    manifest = IngestManifest(manifest_path)

    docs = build_docs(rows, shop)
    new_docs, skipped, deduped = filter_new(docs, manifest, args.force)
    logger.info(
        "after filter: {} new docs, {} manifest-skipped, {} dup-id-deduped",
        len(new_docs), skipped, deduped,
    )

    if args.dry_run:
        for d in new_docs[:3]:
            print(json.dumps(d, ensure_ascii=False, default=str))
        print(f"... total new: {len(new_docs)} (skipped {skipped})")
        return 0

    if not new_docs:
        logger.info("nothing to ingest")
        return 0

    logger.info("POSTing {} docs to {}/index", len(new_docs), args.api_base)
    try:
        result = post_docs(args.api_base, args.collection, new_docs)
    except RuntimeError as e:
        logger.error("{}", e)
        return 1
    record_manifest(manifest, new_docs)
    logger.info("ingested: {}", result)
    return 0
```

(g) 删除原 `main()` 里已不再使用的内联逻辑（旧 `seen_ids` 循环、旧 `docs.append`、旧 httpx POST 块）——上面的 (f) 已是完整替换。确认 `argparse` / `httpx` / `json` import 仍被使用（都还在用）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd services/rag && uv run pytest tests/test_ingest_refund_comments.py -v`
Expected: PASS（6 个测试全绿）。

- [ ] **Step 5: 编译检查**

Run: `cd services/rag && uv run python -m py_compile src/paperclip_rag/ingest/refund_comments.py`
Expected: 无输出（编译通过）。

- [ ] **Step 6: Commit**

```bash
git add services/rag/src/paperclip_rag/ingest/refund_comments.py services/rag/tests/test_ingest_refund_comments.py
git commit -m "refactor(rag,b2): extract reusable ingest functions + file_path/shop id

build_docs/filter_new/post_docs/record_manifest extracted from main() so
the multi-account orchestrator can reuse them. doc id gains a shop prefix
and each doc carries a shop/sku/orderId file_path. main() single-account
CLI behavior unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 多账号编排脚本 `refund_comments_all.py`

**Files:**
- Create: `services/rag/src/paperclip_rag/ingest/refund_comments_all.py`
- Test: `services/rag/tests/test_ingest_refund_comments_all.py` (Create)

- [ ] **Step 1: 写失败测试**

Create `services/rag/tests/test_ingest_refund_comments_all.py`：

```python
from unittest.mock import MagicMock

from paperclip_rag.ingest import refund_comments_all as orch


def test_discover_accounts_filters_everpretty():
    cur = MagicMock()
    cur.fetchall.return_value = [
        {"Account": "EverPretty-US"},
        {"Account": "EverPretty-UK"},
        {"Account": "EverPretty-DE"},
    ]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    accounts = orch.discover_accounts(conn, pattern="EverPretty-%")
    assert accounts == ["EverPretty-US", "EverPretty-UK", "EverPretty-DE"]
    sql, params = cur.execute.call_args[0]
    assert "DISTINCT Account" in sql
    assert params["pat"] == "EverPretty-%"


def test_run_accounts_isolates_a_failing_account(monkeypatch):
    # EP-UK fetch raises; EP-US and EP-DE must still succeed.
    def fake_fetch(conn, account, since, sku_prefix, limit):
        if account == "EverPretty-UK":
            raise RuntimeError("DWS timeout")
        return [{"customerComment": "c", "sellerSku": "S1", "orderId": "o1"}]

    posted: list[tuple[str, int]] = []

    def fake_post(api_base, collection, docs, timeout=14400.0):
        posted.append((collection, len(docs)))
        return {"indexed": len(docs)}

    monkeypatch.setattr(orch, "_fetch_rows", fake_fetch)
    monkeypatch.setattr(orch, "post_docs", fake_post)
    monkeypatch.setattr(orch, "record_manifest", lambda manifest, docs: None)

    manifest = MagicMock()
    manifest.seen.return_value = False

    summary = orch.run_accounts(
        conn=MagicMock(),
        accounts=["EverPretty-US", "EverPretty-UK", "EverPretty-DE"],
        since="2026-01-01",
        limit=500,
        collection="refund_comments_v2",
        api_base="http://x",
        manifest=manifest,
        dry_run=False,
        force=False,
    )

    status = {s["account"]: s["status"] for s in summary}
    assert status["EverPretty-US"] == "ok"
    assert status["EverPretty-DE"] == "ok"
    assert status["EverPretty-UK"].startswith("FAILED")
    assert posted == [("refund_comments_v2", 1), ("refund_comments_v2", 1)]


def test_run_accounts_dry_run_does_not_post(monkeypatch):
    monkeypatch.setattr(
        orch, "_fetch_rows",
        lambda conn, account, since, sku_prefix, limit: [
            {"customerComment": "c", "sellerSku": "S1", "orderId": "o1"}
        ],
    )

    def fail_post(*a, **k):
        raise AssertionError("post_docs must not be called in dry-run")

    monkeypatch.setattr(orch, "post_docs", fail_post)
    manifest = MagicMock()
    manifest.seen.return_value = False

    summary = orch.run_accounts(
        conn=MagicMock(),
        accounts=["EverPretty-US"],
        since="2026-01-01",
        limit=500,
        collection="refund_comments_v2",
        api_base="http://x",
        manifest=manifest,
        dry_run=True,
        force=False,
    )
    assert summary[0]["status"] == "dry-run"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/rag && uv run pytest tests/test_ingest_refund_comments_all.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'paperclip_rag.ingest.refund_comments_all'`。

- [ ] **Step 3: 写编排脚本**

Create `services/rag/src/paperclip_rag/ingest/refund_comments_all.py`：

```python
"""Multi-account ingest orchestrator for the `refund_comments` collection.

Discovers every EverPretty-* account in dws `dm_allretrun_analysis_d`, then
runs the single-account ingest logic (from refund_comments.py) for each one,
writing all docs into ONE shared collection. A single account's failure is
logged and skipped — the run continues.

Usage:
    uv run python -m paperclip_rag.ingest.refund_comments_all \\
        --since 2026-01-01 \\
        [--limit 1000] \\               # per-account row cap
        [--collection refund_comments_v2] \\
        [--account-pattern 'EverPretty-%'] \\
        [--api-base http://127.0.0.1:9001] \\
        [--dry-run] \\
        [--force]
"""
from __future__ import annotations

import argparse
import sys
from typing import Any

from loguru import logger

from ..config import get_settings
from ..manifest import IngestManifest
from .refund_comments import (
    _connect,
    _fetch_rows,
    account_to_shop,
    build_docs,
    filter_new,
    post_docs,
    record_manifest,
)


def discover_accounts(conn: Any, pattern: str = "EverPretty-%") -> list[str]:
    """Return distinct Account values matching `pattern`, sorted."""
    sql = (
        "SELECT DISTINCT Account FROM dm_allretrun_analysis_d "
        "WHERE Account LIKE %(pat)s ORDER BY Account"
    )
    with conn.cursor() as cur:
        cur.execute(sql, {"pat": pattern})
        return [row["Account"] for row in cur.fetchall()]


def run_accounts(
    conn: Any,
    accounts: list[str],
    since: str,
    limit: int,
    collection: str,
    api_base: str,
    manifest: IngestManifest,
    dry_run: bool,
    force: bool,
) -> list[dict[str, Any]]:
    """Ingest each account into `collection`. Per-account failures are isolated.

    Returns a per-account summary list of dicts:
    {account, rows, new_docs, status}.
    """
    summary: list[dict[str, Any]] = []
    for account in accounts:
        entry: dict[str, Any] = {"account": account, "rows": 0, "new_docs": 0}
        try:
            shop = account_to_shop(account)
            rows = _fetch_rows(
                conn, account=account, since=since, sku_prefix=None, limit=limit
            )
            entry["rows"] = len(rows)
            docs = build_docs(rows, shop)
            new_docs, skipped, deduped = filter_new(docs, manifest, force)
            entry["new_docs"] = len(new_docs)
            logger.info(
                "{}: {} rows -> {} new ({} skipped, {} deduped)",
                account, len(rows), len(new_docs), skipped, deduped,
            )
            if dry_run:
                entry["status"] = "dry-run"
            else:
                if new_docs:
                    post_docs(api_base, collection, new_docs)
                    record_manifest(manifest, new_docs)
                entry["status"] = "ok"
        except Exception as e:  # noqa: BLE001 — isolate one account's failure
            logger.error("account {} failed: {}", account, e)
            entry["status"] = f"FAILED: {e}"
        summary.append(entry)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="ISO date, e.g. 2026-01-01")
    parser.add_argument("--limit", type=int, default=1000, help="per-account row cap")
    parser.add_argument("--collection", default="refund_comments_v2")
    parser.add_argument("--account-pattern", default="EverPretty-%")
    parser.add_argument("--api-base", default="http://127.0.0.1:9001")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="bypass manifest skip")
    args = parser.parse_args(argv)

    logger.info("connecting to MySQL")
    try:
        conn = _connect()
    except Exception as e:
        logger.error("DB connect failed: {}", e)
        return 2

    try:
        accounts = discover_accounts(conn, pattern=args.account_pattern)
        logger.info("discovered {} accounts: {}", len(accounts), accounts)
        if not accounts:
            logger.error("no accounts matched pattern {}", args.account_pattern)
            return 2

        settings = get_settings()
        manifest_path = settings.collection_dir(args.collection) / "_manifest.jsonl"
        manifest = IngestManifest(manifest_path)

        summary = run_accounts(
            conn=conn,
            accounts=accounts,
            since=args.since,
            limit=args.limit,
            collection=args.collection,
            api_base=args.api_base,
            manifest=manifest,
            dry_run=args.dry_run,
            force=args.force,
        )
    finally:
        conn.close()

    logger.info("=== ingest summary (collection={}) ===", args.collection)
    for s in summary:
        logger.info(
            "  {:20s} rows={:5d} new={:5d} {}",
            s["account"], s["rows"], s["new_docs"], s["status"],
        )
    failed = [s for s in summary if str(s["status"]).startswith("FAILED")]
    if failed:
        logger.error("{} account(s) failed", len(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd services/rag && uv run pytest tests/test_ingest_refund_comments_all.py -v`
Expected: PASS（3 个测试全绿）。

- [ ] **Step 5: 编译检查 + 全量 RAG 测试回归**

Run: `cd services/rag && uv run python -m py_compile src/paperclip_rag/ingest/refund_comments_all.py && uv run pytest -q`
Expected: 编译无输出；pytest 全绿（含 Task 1/2 的新测试 + 原有套件）。

- [ ] **Step 6: Commit**

```bash
git add services/rag/src/paperclip_rag/ingest/refund_comments_all.py services/rag/tests/test_ingest_refund_comments_all.py
git commit -m "feat(rag,b2): multi-account ingest orchestrator

refund_comments_all.py discovers every EverPretty-* account in DWS and
ingests each into one shared collection. Per-account failures are isolated
so one bad market doesn't abort the whole multi-hour run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: B1 工具 — `shop` 可选 + 来源拼进 answer

**Files:**
- Modify: `packages/tool-registry/src/tools/rag/client.ts` (RagSearchOk interface)
- Modify: `packages/tool-registry/src/tools/rag/searchRefundComments.ts`
- Test: `packages/tool-registry/src/tools/rag/searchRefundComments.test.ts`

- [ ] **Step 1: 写/改测试**

替换 `packages/tool-registry/src/tools/rag/searchRefundComments.test.ts` 里的 `"rejects unsupported shops via zod refine"` 测试（该行为已删除），并新增测试。最终该文件的 `describe` 块内容为：

保留不变的测试：`registers as id...`、`rejects malformed shop pattern`、`rejects empty query`、`rejects query longer than 500 chars`、`wraps RagUnavailable as UpstreamError`、`does NOT wrap unknown errors as UpstreamError`。

删除：`rejects unsupported shops via zod refine`（PZ-US 现在格式合法、不再被白名单拒绝）。

修改 `happy path` 和 `forwards topK` 两个测试 + 新增 4 个测试如下：

```typescript
  it("accepts a valid shop and injects it as a query hint", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "顾客抱怨胸围" });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      shop: "EP-UK",
      query: "胸围紧",
    });
    expect(out.answer).toBe("顾客抱怨胸围");
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "（限定店铺：EP-UK）胸围紧",
      topK: undefined,
    });
  });

  it("works with shop omitted (cross-market) and does not inject a hint", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "跨市场答案" });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "EE02968 的主要投诉",
    });
    expect(out.answer).toBe("跨市场答案");
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "EE02968 的主要投诉",
      topK: undefined,
    });
  });

  it("forwards topK when provided", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "x" });
    await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "x",
      topK: 25,
    });
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "x",
      topK: 25,
    });
  });

  it("appends a parsed source list to the answer", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({
      answer: "顾客主要抱怨尺码偏小。",
      references: [
        { reference_id: "1", file_path: "EP-UK/EE02968/302-111-222" },
        { reference_id: "2", file_path: "EP-DE/EG01923/303-444-555" },
      ],
    });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "尺码问题",
    });
    expect(out.answer).toContain("顾客主要抱怨尺码偏小。");
    expect(out.answer).toContain("**来源**");
    expect(out.answer).toContain("EP-UK / EE02968 / 302-111-222");
    expect(out.answer).toContain("EP-DE / EG01923 / 303-444-555");
    expect(out.references).toHaveLength(2);
  });

  it("leaves the answer untouched when there are no references", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "无证据答案", references: [] });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "x",
    });
    expect(out.answer).toBe("无证据答案");
    expect(out.references).toEqual([]);
  });
```

注意：把原 `happy path returns parsed RAG response` 测试里用到的 `{ shop: "EP-US", ... }` 已被上面 `accepts a valid shop...` 覆盖，删除原 happy-path 测试避免重复。`wraps RagUnavailable` / `does NOT wrap` 两个测试里的 `{ shop: "EP-US", query: "x" }` 入参保持不变即可（`shop` 仍接受合法值）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/tool-registry && pnpm vitest run src/tools/rag/searchRefundComments.test.ts`
Expected: FAIL — handler 还没做 shop 注入和来源拼接；`references` 不在 outputSchema 里。

- [ ] **Step 3: client.ts 加 references 字段**

`packages/tool-registry/src/tools/rag/client.ts` 的 `RagSearchOk` interface 改为：

```typescript
export interface RagSearchOk {
  answer: string;
  references?: Array<{ reference_id: string; file_path: string }>;
  meta?: {
    translation?: string | null;
    originalQuery?: string | null;
    translatedQuery?: string | null;
    translateMs?: number | null;
    fallbackReason?: string | null;
  } | null;
}
```

（`ragSearch` 已是 `return (await response.json()) as RagSearchOk` —— references 自动透传，无需改函数体。）

- [ ] **Step 4: 改写 searchRefundComments.ts**

完整替换 `packages/tool-registry/src/tools/rag/searchRefundComments.ts`：

```typescript
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { UpstreamError } from "../../errors.js";
import { ragSearch, RagUnavailable } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z
      .string()
      .regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc.")
      .optional(),
    query: z.string().min(1).max(500),
    topK: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const metaSchema = z
  .object({
    translation: z.enum(["passthrough", "translated", "fallback"]).nullable().optional(),
    originalQuery: z.string().nullable().optional(),
    translatedQuery: z.string().nullable().optional(),
    translateMs: z.number().nullable().optional(),
    fallbackReason: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const referenceSchema = z.object({
  reference_id: z.string(),
  file_path: z.string(),
});

const outputSchema = z.object({
  answer: z.string(),
  references: z.array(referenceSchema).default([]),
  meta: metaSchema,
});

export type RagSearchRefundCommentsInput = z.infer<typeof inputSchema>;
export type RagSearchRefundCommentsOutput = z.infer<typeof outputSchema>;

/** Render `EP-UK/EE02968/302-111-222` as `EP-UK / EE02968 / 302-111-222`. */
function formatReference(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length === 3 ? parts.join(" / ") : filePath;
}

/** Append a human-readable source list so the DingTalk bot shows it verbatim. */
function appendReferences(
  answer: string,
  references: z.infer<typeof referenceSchema>[],
): string {
  if (references.length === 0) return answer;
  const lines = references
    .slice(0, 8)
    .map((r) => `- ${formatReference(r.file_path)}`);
  return `${answer}\n\n---\n**来源**（${references.length} 条客户评论）：\n${lines.join("\n")}`;
}

async function handler(
  _ctx: ExecutionContext,
  input: RagSearchRefundCommentsInput,
): Promise<RagSearchRefundCommentsOutput> {
  const query = input.shop ? `（限定店铺：${input.shop}）${input.query}` : input.query;
  try {
    const r = await ragSearch({
      collection: "refund_comments",
      query,
      topK: input.topK,
    });
    const parsed = outputSchema.parse(r);
    return {
      ...parsed,
      answer: appendReferences(parsed.answer, parsed.references),
    };
  } catch (e) {
    if (e instanceof RagUnavailable) {
      throw new UpstreamError(`rag service unavailable: ${e.message}`);
    }
    throw e;
  }
}

export const searchRefundCommentsDescriptor: ToolDescriptor<
  RagSearchRefundCommentsInput,
  RagSearchRefundCommentsOutput
> = {
  id: "rag.searchRefundComments",
  cliSubcommand: "search-refund-comments",
  source: "rag",
  description:
    "Semantic search over ingested customer refund comments, augmented by an " +
    "entity knowledge graph (SKU / styleCode / returnReason / size / color). " +
    "Returns a synthesized Chinese answer based on retrieved customer-comment " +
    "evidence, with a source list appended. " +
    "USE FOR: open-ended 'why are customers complaining' / 'what's the real " +
    "issue behind this return-reason code' / 'main complaints for SKU X' " +
    "semantic questions. CN and EN queries both work natively via the " +
    "multilingual bge-m3 embedding (no translation step). " +
    "DO NOT USE FOR: structured filtering (specific orderId, exact SKU+date " +
    "lookups, quantity thresholds) — use dws.refundComments instead. " +
    "ON ERROR: any error class (typically 'UpstreamError' when the RAG " +
    "service is down) means you should retry with dws.refundComments + a " +
    "CN keyword LIKE filter, and note '⚠️ RAG 暂不可用' in the reply. " +
    "SHOP: optional — pass a shop (EP-US, EP-UK, ...) to scope the answer to " +
    "one market; omit it to search across all ingested EP markets. " +
    "CURRENT INGEST: all EP Amazon markets.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: [],
  handler,
};
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/tool-registry && pnpm vitest run src/tools/rag/searchRefundComments.test.ts`
Expected: PASS（全部测试绿）。

- [ ] **Step 6: 类型检查**

Run: `cd packages/tool-registry && pnpm tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add packages/tool-registry/src/tools/rag/client.ts packages/tool-registry/src/tools/rag/searchRefundComments.ts packages/tool-registry/src/tools/rag/searchRefundComments.test.ts
git commit -m "feat(b2): rag.searchRefundComments — optional shop + source list

shop becomes optional (omit = cross-market search); the supported-shops
whitelist is dropped now that all EP markets are ingested. The handler
appends a parsed 站点/SKU/订单 source list to the answer so the DingTalk
bot renders it with no cross-repo change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 切换 playbook（操作型，非 TDD）

**这是运维步骤，不写测试。** 由操作者（带 DWS DB 凭据 + LM Studio 运行中）执行。前置：Task 1–4 已合并，RAG 服务在跑，`bge-m3` 已在 LM Studio 加载。

- [ ] **Step 1: 后台启动全市场 ingest 到 `refund_comments_v2`**

确认 `DWS_DB_*` 环境变量已 export，RAG 服务在 `http://127.0.0.1:9001` 运行，然后：

```bash
cd services/rag
nohup uv run python -m paperclip_rag.ingest.refund_comments_all \
  --since 2026-01-01 --limit 1000 --collection refund_comments_v2 \
  > /tmp/b2_ingest.log 2>&1 &
echo "ingest pid=$!"
```

预计数小时。`tail -f /tmp/b2_ingest.log` 看进度，结尾会打印每账号 summary 表。

- [ ] **Step 2: 验证 `refund_comments_v2`**

ingest 结束（日志出现 summary 表、无 `FAILED` 行）后跑验证：

```bash
# 2a — references 非空 + file_path 形如 shop/sku/orderId
curl -s -XPOST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments_v2","query":"EE02968 顾客主要抱怨什么","top_k":10}' \
  | python3 -m json.tool | grep -E '"(answer|file_path|reference_id)"' | head -20
```

通过标准：`references` 数组非空；`file_path` 形如 `EP-XX/SKU/orderId`（三段）。

```bash
# 2b — 跨市场召回：换一个跨多站点在售的 SKU，确认 chunks 里出现 >1 个不同 EP-XX 前缀
curl -s -XPOST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments_v2","query":"尺码偏小的投诉","top_k":20}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(sorted({c.get('file_path','').split('/')[0] for c in d.get('chunks',[])}))"
```

通过标准：打印出的 shop 前缀集合包含 ≥2 个不同市场。

若验证不通过：不要切换。`refund_comments_v2` 是旁路目录，线上 `refund_comments` 未受影响——排查 ingest 日志即可。

- [ ] **Step 3: 原子切换**

```bash
TS=$(date +%Y%m%d-%H%M%S)
STORAGE=~/.paperclip/lightrag-storage   # 若 PAPERCLIP_RAG_STORAGE_ROOT 改过则相应调整
# 停 RAG 服务（按本机 dev 方式停，确保进程不再持有 collection 目录）
mv "$STORAGE/refund_comments" "$STORAGE/refund_comments_pre-b2-$TS"
mv "$STORAGE/refund_comments_v2" "$STORAGE/refund_comments"
# 重启 RAG 服务
echo "cutover done; old collection kept at refund_comments_pre-b2-$TS"
```

- [ ] **Step 4: 切换后冒烟**

```bash
curl -s -XPOST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"EE02968 顾客主要抱怨什么","top_k":10}' \
  | python3 -m json.tool | grep -E '"(answer|reference_id)"' | head
```

通过标准：`refund_comments`（B1 工具硬编码的名字）返回带 references 的答案。再在钉钉群 @机器人问一句中文退货问题，确认回答末尾出现「来源」段。

- [ ] **Step 5: 留旧目录待回滚**

`refund_comments_pre-b2-<TS>` 保留至少数天。回滚 = 停服务 → 反向 `mv` → 重启。确认稳定后再 `rm -rf` 旧目录。

---

## Self-Review 记录

- **Spec 覆盖：** §5① 编排→Task 3；§5② /index file_path→Task 1；§5③ B1 工具→Task 4；§5④ 切换→Task 5；§5⑤ 测试→各 Task 内 TDD 步骤。`refund_comments.py` 重构（§5① 末段）→Task 2。全部覆盖。
- **Placeholder 扫描：** 无 TBD / TODO；每个代码步骤含完整代码。
- **类型一致性：** `build_docs` / `filter_new` / `post_docs` / `record_manifest` / `account_to_shop` 在 Task 2 定义，Task 3 import 同名调用一致。`reference_id` / `file_path` snake_case 贯穿 Task 1 测试、Task 4 outputSchema 与 wire 格式一致。
- **已知取舍：** B1 `metaSchema` 沿用 camelCase（`translateMs` 等）是 B2 之前就存在的隐性不一致（wire 是 snake_case），不在 B2 范围内，未改动。
