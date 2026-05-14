# paperclip RAG Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest 500 real refund_comments rows into a `refund_comments` LightRAG collection and measure retrieval quality, so Phase 2b's prompt/chunk tuning has ground truth to tune against.

**Architecture:** Adds three things to the Phase 1 service: (1) an append-only manifest for ingest idempotency, (2) a refund_comments ingest CLI that pulls from the existing `dws_od_amazon_refund_rate_d` MySQL table, (3) two inspector scripts (`inspect_kg.py` for KG sanity, `eval_search.py` for 10-query manual relevance scoring). Two small Phase 1 carry-forward fixes go in: rotating loguru file sinks under `_logs/rag/`, and an embedding-dim startup probe.

**Tech Stack:** Reuses Phase 1 stack (Python 3.11, uv, FastAPI, LightRAG, LM Studio). New: `pymysql` (already in `[mysql]` extra), no other new deps.

**Spec reference:** `docs/superpowers/specs/2026-05-13-paperclip-rag-design.md` §6 (Phase 2a), §7 (manifest, dim probe), §8 (KG sanity threshold ≥ 100 entity / 50 relation), §9 (Phase 2a Done = 500 ingested + KG threshold + manual ≥ 70% top-3 hit-rate).

**Prerequisites (must be true before starting):**
- `feat/rag-phase1` is merged to master, OR Phase 2a is built on top of `feat/rag-phase1` (then merged together).
- LM Studio running on `127.0.0.1:1234` with Qwen3-30B-A3B-Instruct-2507 + nomic-embed-text-v1.5 loaded.
- MySQL `dws` env vars are reachable from this machine: `DWS_DB_HOST`, `DWS_DB_USER`, `DWS_DB_PASSWORD`, `DWS_DB_DATABASE`, optional `DWS_DB_PORT`. Check via `python -c "import os; print({k:bool(os.environ.get(k)) for k in ['DWS_DB_HOST','DWS_DB_USER','DWS_DB_PASSWORD','DWS_DB_DATABASE']})"`.
- Phase 1 e2e canary (`scripts/test_e2e.py`) exits 0.

---

## File Structure

```
services/rag/
├── src/paperclip_rag/
│   ├── manifest.py                        # Task 1：append-only JSONL ingest ledger
│   ├── logging_setup.py                   # Task 2：loguru file sinks under _logs/rag/
│   ├── api.py                             # Task 2,3：startup dim probe + manifest wiring
│   └── ingest/
│       └── refund_comments.py             # Task 4：MySQL → /index CLI
├── scripts/
│   ├── inspect_kg.py                      # Task 5：count entities/relations + dump samples
│   └── eval_search.py                     # Task 6：10-query manual eval harness
└── tests/
    ├── test_manifest.py                   # Task 1
    ├── test_logging_setup.py              # Task 2
    └── test_startup_dim_probe.py          # Task 3

docs/superpowers/specs/
└── 2026-05-14-phase2a-eval-rubric.md      # Task 6：human eval criteria for the 10 queries
```

Plus a small read-only one-liner appended to `services/rag/.env.example` for the new env vars.

---

### Task 1: Manifest module (manifest.py) — TDD

**Files:**
- Create: `services/rag/src/paperclip_rag/manifest.py`
- Create: `services/rag/tests/test_manifest.py`

**Why:** Phase 1 had 21 docs so LightRAG's internal doc-dedupe sufficed. Phase 2 re-runs (500 → tune → 500 again) need an external account of what's been ingested. Append-only JSONL keyed by `(source_id, content_sha256)`.

- [ ] **Step 1: Write failing test `tests/test_manifest.py`**

```python
import json
from datetime import datetime
from pathlib import Path

from paperclip_rag.manifest import IngestManifest


def test_appends_and_reads(tmp_path: Path):
    m = IngestManifest(tmp_path / "_manifest.jsonl")
    assert m.seen("rc-1", "hash-abc") is False
    m.record("rc-1", "hash-abc", chunk_count=2)
    assert m.seen("rc-1", "hash-abc") is True


def test_different_hash_not_seen(tmp_path: Path):
    m = IngestManifest(tmp_path / "_manifest.jsonl")
    m.record("rc-1", "hash-abc", chunk_count=1)
    assert m.seen("rc-1", "hash-different") is False


def test_reload_from_disk(tmp_path: Path):
    p = tmp_path / "_manifest.jsonl"
    m1 = IngestManifest(p)
    m1.record("a", "h", chunk_count=1)

    m2 = IngestManifest(p)
    assert m2.seen("a", "h") is True


def test_record_writes_iso_timestamp(tmp_path: Path):
    p = tmp_path / "_manifest.jsonl"
    m = IngestManifest(p)
    m.record("a", "h", chunk_count=1)
    obj = json.loads(p.read_text().strip().splitlines()[-1])
    assert obj["source_id"] == "a"
    assert obj["content_sha256"] == "h"
    assert obj["chunk_count"] == 1
    datetime.fromisoformat(obj["ingested_at"])


def test_skips_corrupt_lines(tmp_path: Path):
    p = tmp_path / "_manifest.jsonl"
    p.write_text(
        '{"source_id":"a","content_sha256":"h","chunk_count":1,"ingested_at":"2026-05-14T00:00:00+00:00"}\n'
        "not valid json\n"
        '{"source_id":"b","content_sha256":"h","chunk_count":1,"ingested_at":"2026-05-14T00:00:00+00:00"}\n'
    )
    m = IngestManifest(p)
    assert m.seen("a", "h") is True
    assert m.seen("b", "h") is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/rag && uv run pytest tests/test_manifest.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `src/paperclip_rag/manifest.py`**

```python
"""Append-only JSONL ingest ledger for idempotent re-runs."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


class IngestManifest:
    """Tracks which (source_id, content_sha256) pairs have been ingested."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._seen: set[tuple[str, str]] = set()
        if self.path.exists():
            with self.path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    sid = obj.get("source_id")
                    sha = obj.get("content_sha256")
                    if sid and sha:
                        self._seen.add((sid, sha))

    def seen(self, source_id: str, content_sha256: str) -> bool:
        return (source_id, content_sha256) in self._seen

    def record(
        self,
        source_id: str,
        content_sha256: str,
        chunk_count: int,
    ) -> None:
        entry = {
            "source_id": source_id,
            "content_sha256": content_sha256,
            "chunk_count": chunk_count,
            "ingested_at": datetime.now(timezone.utc).isoformat(),
        }
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self._seen.add((source_id, content_sha256))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/rag && uv run pytest tests/test_manifest.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/rag/src/paperclip_rag/manifest.py services/rag/tests/test_manifest.py
git commit -m "feat(rag): JSONL ingest manifest for idempotent re-runs"
```

---

### Task 2: Loguru file sinks (logging_setup.py) — TDD

**Files:**
- Create: `services/rag/src/paperclip_rag/logging_setup.py`
- Create: `services/rag/tests/test_logging_setup.py`
- Modify: `services/rag/src/paperclip_rag/api.py:lifespan` — call `configure_logging(settings.log_dir)` on startup

**Why:** Phase 1 final review noted `log_dir` is configured but no `logger.add(...)` writes there. Phase 2 ingest jobs run for an hour+ and need durable logs for postmortem.

- [ ] **Step 1: Write failing test `tests/test_logging_setup.py`**

```python
from pathlib import Path

from loguru import logger

from paperclip_rag.logging_setup import configure_logging


def test_creates_log_files(tmp_path: Path):
    configure_logging(tmp_path)
    logger.info("hello from test")
    logger.complete()  # flush
    files = list(tmp_path.glob("*.log"))
    assert len(files) >= 1
    contents = files[0].read_text()
    assert "hello from test" in contents


def test_idempotent_multiple_calls(tmp_path: Path):
    configure_logging(tmp_path)
    configure_logging(tmp_path)  # second call must not crash
    logger.info("post-reconfigure")
    logger.complete()
    files = list(tmp_path.glob("*.log"))
    assert len(files) >= 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/rag && uv run pytest tests/test_logging_setup.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `src/paperclip_rag/logging_setup.py`**

```python
"""Configure loguru sinks for paperclip-rag.

Adds a daily-rotated file sink under `log_dir`. Keeps the default stderr sink
so uvicorn output still appears in the terminal.
"""
from __future__ import annotations

import sys
from pathlib import Path

from loguru import logger

_CONFIGURED_DIRS: set[Path] = set()


def configure_logging(log_dir: Path) -> None:
    """Idempotent. Safe to call multiple times during reload/dev."""
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    if log_dir in _CONFIGURED_DIRS:
        return
    logger.remove()
    logger.add(sys.stderr, level="INFO")
    logger.add(
        log_dir / "paperclip-rag-{time:YYYY-MM-DD}.log",
        level="INFO",
        rotation="00:00",
        retention="14 days",
        encoding="utf-8",
        enqueue=True,
    )
    _CONFIGURED_DIRS.add(log_dir)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/rag && uv run pytest tests/test_logging_setup.py -v`
Expected: 2 passed.

- [ ] **Step 5: Wire into `api.py` lifespan**

Edit `services/rag/src/paperclip_rag/api.py`. Find the lifespan handler:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    logger.info("paperclip-rag starting on {}:{}", settings.host, settings.port)
    yield
```

Change to:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    from .logging_setup import configure_logging
    configure_logging(settings.log_dir)
    logger.info("paperclip-rag starting on {}:{}", settings.host, settings.port)
    yield
```

(Import is lazy to keep the test_api.py monkey-patched fixtures clean.)

- [ ] **Step 6: Run full suite to confirm no regression**

Run: `cd services/rag && uv run pytest -v`
Expected: 26 + 5 (Task 1) + 2 (Task 2) = **33 passed**.

- [ ] **Step 7: Commit**

```bash
git add services/rag/src/paperclip_rag/logging_setup.py \
        services/rag/tests/test_logging_setup.py \
        services/rag/src/paperclip_rag/api.py
git commit -m "feat(rag): daily-rotated loguru file sink wired into FastAPI lifespan"
```

---

### Task 3: Embedding-dim startup probe — TDD

**Files:**
- Modify: `services/rag/src/paperclip_rag/api.py:lifespan` — call probe before `yield`
- Modify: `services/rag/src/paperclip_rag/lm_studio.py` — add `probe_embedding_dim()` method
- Create: `services/rag/tests/test_startup_dim_probe.py`

**Why:** Spec §7 says "Embedding 维度不匹配 → 服务拒绝启动". Phase 2 will swap embedding models more often (testing tone/quality trade-offs) and a silent dimension mismatch corrupts the vector index.

- [ ] **Step 1: Write failing test `tests/test_startup_dim_probe.py`**

```python
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
from fastapi.testclient import TestClient

from paperclip_rag.api import build_app
from paperclip_rag.config import Settings


@pytest.fixture
def factory_mock():
    class _F:
        async def get(self, c): raise AssertionError("should not be called")
        def cached_collections(self): return []
    return _F()


def test_dim_probe_rejects_mismatch(monkeypatch, tmp_path, factory_mock):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    monkeypatch.setenv("PAPERCLIP_RAG_EMBEDDING_DIM", "768")
    settings = Settings()

    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(return_value="up")
    # Probe returns 1024-dim vec, settings says 768 → must error
    lm_client.embed = AsyncMock(return_value=np.zeros((1, 1024), dtype=np.float32))

    app = build_app(settings=settings, factory=factory_mock, lm_client=lm_client)
    with pytest.raises(RuntimeError, match="embedding dim mismatch"):
        with TestClient(app) as _:
            pass


def test_dim_probe_passes_match(monkeypatch, tmp_path, factory_mock):
    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    monkeypatch.setenv("PAPERCLIP_RAG_EMBEDDING_DIM", "768")
    settings = Settings()

    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(return_value="up")
    lm_client.embed = AsyncMock(return_value=np.zeros((1, 768), dtype=np.float32))

    app = build_app(settings=settings, factory=factory_mock, lm_client=lm_client)
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 200


def test_dim_probe_skipped_when_lm_studio_down(monkeypatch, tmp_path, factory_mock):
    """If LM Studio is unreachable at startup, service still starts but logs warning.
    Reasoning: we shouldn't crash dev workflows just because LM Studio is paused.
    """
    from paperclip_rag.lm_studio import LMStudioUnavailable

    monkeypatch.setenv("PAPERCLIP_RAG_STORAGE_ROOT", str(tmp_path))
    settings = Settings()

    lm_client = MagicMock()
    lm_client.healthcheck = AsyncMock(side_effect=LMStudioUnavailable("down"))
    lm_client.embed = AsyncMock(side_effect=LMStudioUnavailable("down"))

    app = build_app(settings=settings, factory=factory_mock, lm_client=lm_client)
    # Should NOT raise — startup proceeds even though LM is down
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 503  # /healthz reports the outage, startup didn't crash
```

- [ ] **Step 2: Implement probe in `lm_studio.py`**

Append to `LMStudioClient` class:

```python
async def probe_embedding_dim(self) -> int:
    """Return the dimensionality of a single-element embedding batch."""
    arr = await self.embed(["probe"])
    return int(arr.shape[1])
```

- [ ] **Step 3: Wire into `api.py` lifespan**

After the `configure_logging(...)` line added in Task 2, add:

```python
# Startup dim probe: refuse to start if embedding dim != settings.embedding_dim.
# Soft-fail if LM Studio is unreachable (logs warning, lets dev workflows proceed).
try:
    actual_dim = await lm_client.probe_embedding_dim()
    if actual_dim != settings.embedding_dim:
        raise RuntimeError(
            f"embedding dim mismatch: settings={settings.embedding_dim} "
            f"but probe returned {actual_dim} (model={settings.embedding_model})"
        )
    logger.info("embedding dim probe passed: {}", actual_dim)
except LMStudioUnavailable as e:
    logger.warning(
        "LM Studio unreachable at startup; skipping dim probe. /healthz will report. {}",
        e,
    )
```

`LMStudioUnavailable` is already imported. `RuntimeError` is builtin.

- [ ] **Step 4: Run test to verify both pass**

Run: `cd services/rag && uv run pytest tests/test_startup_dim_probe.py -v`
Expected: 3 passed.

- [ ] **Step 5: Run full suite**

Run: `cd services/rag && uv run pytest -v`
Expected: **36 passed** (33 + 3).

- [ ] **Step 6: Commit**

```bash
git add services/rag/src/paperclip_rag/lm_studio.py \
        services/rag/src/paperclip_rag/api.py \
        services/rag/tests/test_startup_dim_probe.py
git commit -m "feat(rag): startup embedding-dim probe with soft-fail on LM Studio down"
```

---

### Task 4: refund_comments ingest CLI (ingest/refund_comments.py)

**Files:**
- Create: `services/rag/src/paperclip_rag/ingest/refund_comments.py`
- Modify: `services/rag/.env.example` — append MySQL env vars

**Why no unit test:** Same reasoning as Phase 1 Task 7 — argparse + DB query + POST is glue, covered by the manifest test (Task 1) and the Task 8 live pilot run.

- [ ] **Step 1: Append MySQL env vars to `services/rag/.env.example`**

Add these lines at the bottom:

```bash
# MySQL (read-only) for refund_comments ingest.
# These match the existing dws/_query.py contract.
DWS_DB_HOST=
DWS_DB_PORT=3306
DWS_DB_USER=
DWS_DB_PASSWORD=
DWS_DB_DATABASE=
PAPERCLIP_RAG_INGEST_ACCOUNT=EverPretty-US
```

`PAPERCLIP_RAG_INGEST_ACCOUNT` is the Amazon seller account to filter by (default `EverPretty-US`).

- [ ] **Step 2: Implement `src/paperclip_rag/ingest/refund_comments.py`**

```python
"""Ingest refund_comments from MySQL into the `refund_comments` LightRAG collection.

Schema source: packages/tool-registry/src/tools/dws/_query.py::refund_comments

For each row, build a single text body from `customerComment` plus structured
context (SKU, size, color, return reason). Use the orderId + sellerSku as
source_id; sha256 of the comment body as content hash for manifest idempotency.

Usage:
    uv run python -m paperclip_rag.ingest.refund_comments \\
        --since 2026-01-01 \\
        --limit 500 \\
        [--sku-prefix EG] \\
        [--account ACCOUNT_ID]      # else read PAPERCLIP_RAG_INGEST_ACCOUNT
        [--api-base http://127.0.0.1:9001] \\
        [--collection refund_comments] \\
        [--dry-run] \\
        [--force]                    # bypass manifest skip
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterator

import httpx
import pymysql
from loguru import logger
from pymysql.cursors import DictCursor

from ..config import get_settings
from ..manifest import IngestManifest


_REQUIRED_ENV = ("DWS_DB_HOST", "DWS_DB_USER", "DWS_DB_PASSWORD", "DWS_DB_DATABASE")


def _connect() -> pymysql.Connection:
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
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


def _fetch_rows(
    conn: pymysql.Connection,
    account: str,
    since: str,
    sku_prefix: str | None,
    limit: int,
) -> list[dict[str, Any]]:
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
        return list(cur.fetchall())


def _row_to_text(r: dict[str, Any]) -> str:
    """Build a single-paragraph text body from a refund comment row.

    Each row becomes a self-contained chunk: customer comment + structured
    context. Keep concise — LightRAG chunking will split if needed.
    """
    parts = [f"customer_comment: {r.get('customerComment', '').strip()}"]
    for k in ("sellerSku", "styleCode", "size", "color", "returnReason"):
        v = r.get(k)
        if v is None or v == "":
            continue
        parts.append(f"{k}: {v}")
    if r.get("quantity") is not None:
        parts.append(f"quantity: {r['quantity']}")
    return "\n".join(parts)


def _row_id(r: dict[str, Any]) -> str:
    """Source ID = order_id + seller_sku, stable across re-runs."""
    oid = str(r.get("orderId") or "")
    sku = str(r.get("sellerSku") or "")
    return f"{oid}::{sku}" if oid or sku else f"row:{hash(json.dumps(r, default=str)) & 0xFFFFFFFF:x}"


def _content_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


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

    docs = []
    skipped = 0
    for r in rows:
        text = _row_to_text(r)
        sid = _row_id(r)
        sha = _content_sha(text)
        if not args.force and manifest.seen(sid, sha):
            skipped += 1
            continue
        docs.append({
            "id": sid,
            "text": text,
            "metadata": {
                "source": "dws_od_amazon_refund_rate_d",
                "sellerSku": r.get("sellerSku"),
                "styleCode": r.get("styleCode"),
                "eventDate": str(r.get("eventDate") or ""),
                "returnReason": r.get("returnReason"),
                "orderId": r.get("orderId"),
                "_sha": sha,
            },
        })

    logger.info("after manifest filter: {} new docs, {} skipped", len(docs), skipped)

    if args.dry_run:
        for d in docs[:3]:
            print(json.dumps(d, ensure_ascii=False, default=str))
        print(f"... total new: {len(docs)} (skipped {skipped})")
        return 0

    if not docs:
        logger.info("nothing to ingest")
        return 0

    payload = {"collection": args.collection, "docs": docs, "upsert": True}
    logger.info("POSTing {} docs to {}/index", len(docs), args.api_base)
    with httpx.Client(timeout=3600.0) as client:
        r = client.post(f"{args.api_base}/index", json=payload)
    if r.status_code >= 300:
        logger.error("ingest failed: {} {}", r.status_code, r.text)
        return 1

    # Manifest write only on success
    for d in docs:
        manifest.record(d["id"], d["metadata"]["_sha"], chunk_count=1)
    logger.info("ingested: {}", r.json())
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Smoke `--dry-run` against MySQL (small batch)**

```bash
cd services/rag
uv run python -m paperclip_rag.ingest.refund_comments \
    --since 2026-04-01 --limit 5 --dry-run \
    --account "${PAPERCLIP_RAG_INGEST_ACCOUNT}"
```

Expected: prints 3 docs as JSON + `... total new: 5 (skipped 0)`. Each doc has non-empty `customer_comment:` and metadata.

If DB connect fails with env-var missing: the message tells you which one. Fill `.env` and retry.

- [ ] **Step 4: Run full suite (Task 4 adds no tests but a typo breaks import)**

Run: `cd services/rag && uv run pytest -v`
Expected: 36 passed (unchanged from Task 3).

- [ ] **Step 5: Commit**

```bash
git add services/rag/src/paperclip_rag/ingest/refund_comments.py \
        services/rag/.env.example
git commit -m "feat(rag): refund_comments MySQL → /index ingest CLI"
```

---

### Task 5: KG inspector script (scripts/inspect_kg.py)

**Files:**
- Create: `services/rag/scripts/inspect_kg.py`

**Why:** Phase 2a Done criterion is "KG ≥ 100 entity / 50 relation". Need a one-shot CLI that counts entities + relations in a collection's working_dir and dumps a sample for eyeballing.

- [ ] **Step 1: Implement `scripts/inspect_kg.py`**

```python
#!/usr/bin/env python3
"""Inspect a LightRAG collection's KG: count entities, relations, dump samples.

LightRAG stores the KG as NetworkX graphml under
    ~/.paperclip/lightrag-storage/<collection>/graph_chunk_entity_relation.graphml
plus three vector DB JSON files. We read graphml directly (NetworkX) and JSON
for chunk counts.

Usage:
    ./scripts/inspect_kg.py refund_comments [--sample 5]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import networkx as nx
from loguru import logger

from paperclip_rag.config import get_settings


def inspect(collection: str, sample: int) -> dict[str, Any]:
    settings = get_settings()
    working_dir = settings.collection_dir(collection)
    report: dict[str, Any] = {"collection": collection, "path": str(working_dir)}

    graphml = working_dir / "graph_chunk_entity_relation.graphml"
    if graphml.exists():
        g = nx.read_graphml(graphml)
        report["entity_count"] = g.number_of_nodes()
        report["relation_count"] = g.number_of_edges()

        # Sample entities by node type
        nodes_by_type: dict[str, list[str]] = {}
        for n, data in g.nodes(data=True):
            t = data.get("entity_type", "unknown")
            nodes_by_type.setdefault(t, []).append(n)
        report["entities_by_type"] = {t: len(v) for t, v in nodes_by_type.items()}
        report["entity_samples"] = {
            t: v[:sample] for t, v in nodes_by_type.items()
        }

        # Sample relations
        report["relation_samples"] = []
        for u, v, data in list(g.edges(data=True))[:sample]:
            report["relation_samples"].append({
                "src": u,
                "tgt": v,
                "description": data.get("description", "")[:120],
            })
    else:
        report["entity_count"] = 0
        report["relation_count"] = 0
        report["note"] = "graphml not found — collection empty or not yet ingested"

    chunks_json = working_dir / "kv_store_text_chunks.json"
    if chunks_json.exists():
        try:
            report["chunk_count"] = len(json.loads(chunks_json.read_text()))
        except json.JSONDecodeError:
            report["chunk_count"] = -1

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collection")
    parser.add_argument("--sample", type=int, default=5)
    parser.add_argument("--threshold-entities", type=int, default=100,
                       help="exit non-zero if entity_count < this")
    parser.add_argument("--threshold-relations", type=int, default=50)
    args = parser.parse_args(argv)

    report = inspect(args.collection, args.sample)
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))

    ec = report.get("entity_count", 0)
    rc = report.get("relation_count", 0)
    if ec < args.threshold_entities or rc < args.threshold_relations:
        logger.error(
            "KG below threshold: entities={}/{}, relations={}/{}",
            ec, args.threshold_entities, rc, args.threshold_relations,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`chmod +x services/rag/scripts/inspect_kg.py`

- [ ] **Step 2: Syntax + import check**

```bash
cd services/rag
uv run python -c "import ast; ast.parse(open('scripts/inspect_kg.py').read()); print('ok')"
uv run python scripts/inspect_kg.py decisions --threshold-entities 0 --threshold-relations 0
```

Expected: prints JSON report. If `decisions` collection has been built by Phase 1, you'll see real numbers; otherwise the "graphml not found" note.

- [ ] **Step 3: Commit**

```bash
git add services/rag/scripts/inspect_kg.py
git commit -m "feat(rag): KG inspector script with entity/relation thresholds"
```

---

### Task 6: Manual eval harness (scripts/eval_search.py + rubric spec)

**Files:**
- Create: `services/rag/scripts/eval_search.py`
- Create: `docs/superpowers/specs/2026-05-14-phase2a-eval-rubric.md`

**Why:** Phase 2a Done criterion: "10 query 人工抽检命中率 ≥ 70%". The harness POSTs 10 fixed queries, dumps top-3 chunks and the answer, and writes to a markdown sheet where the human grades each row.

- [ ] **Step 1: Write the rubric spec `docs/superpowers/specs/2026-05-14-phase2a-eval-rubric.md`**

```markdown
# Phase 2a Eval Rubric — refund_comments Manual Relevance Check

## 10 Fixed Queries

These cover the high-value scenarios spec §6 names (sizing / quality / logistics / channel-specific).

| # | Query | Scenario |
|---|---|---|
| 1 | 偏小 升一码 | Sizing — runs small |
| 2 | 偏大 降一码 | Sizing — runs big |
| 3 | 物流损坏 包装 | Logistics damage |
| 4 | 做工 缝线 质量 | Workmanship / stitching |
| 5 | 颜色差 色差 | Color mismatch |
| 6 | 不符合描述 与图片不符 | Listing vs reality |
| 7 | EG02084 | Specific SKU pull |
| 8 | Amazon 退货 | Channel — Amazon |
| 9 | 没收到 物流丢失 | Shipping lost |
| 10 | 异味 味道大 | Smell / odor complaints |

## Grading

For each query, the harness prints:
- top-3 chunks (id + first 200 chars + score if available)
- the synthesized `answer`

Grade each query on **top-3 hit rate**: at least 1 of the top 3 chunks must be substantively about the queried scenario.

- **Hit** = at least 1 of top-3 chunks is on-topic for the query
- **Miss** = none of top-3 are on-topic, OR all 3 are duplicates of a single irrelevant row

Phase 2a passes if **≥ 7 of 10 queries are Hits** (70%).

If 7–8: borderline, proceed to Phase 2b prompt tuning but flag the misses.
If < 7: Phase 2a not done. Adjust `entity_types` in `lightrag_factory.py`, re-ingest, re-grade.

## Score sheet

After running `./scripts/eval_search.py`, paste output into
`docs/superpowers/specs/2026-05-14-phase2a-eval-results.md` and add a
Hit/Miss column per query. Commit the results file.
```

- [ ] **Step 2: Implement `services/rag/scripts/eval_search.py`**

```python
#!/usr/bin/env python3
"""Phase 2a manual eval harness — runs 10 fixed queries against refund_comments
and prints top-3 chunks + the answer in markdown so a human can grade.

Usage:
    ./scripts/eval_search.py [--collection refund_comments] [--out RESULTS.md]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import httpx


QUERIES = [
    "偏小 升一码",
    "偏大 降一码",
    "物流损坏 包装",
    "做工 缝线 质量",
    "颜色差 色差",
    "不符合描述 与图片不符",
    "EG02084",
    "Amazon 退货",
    "没收到 物流丢失",
    "异味 味道大",
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", default="refund_comments")
    parser.add_argument("--api-base", default=os.environ.get(
        "PAPERCLIP_RAG_API", "http://127.0.0.1:9001"))
    parser.add_argument("--mode", default="hybrid")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--out", type=Path, default=None,
                       help="write markdown report to this path")
    args = parser.parse_args(argv)

    lines: list[str] = ["# Phase 2a eval — refund_comments\n"]
    lines.append("| # | Query | Hit/Miss | Note |\n|---|---|---|---|")
    detail: list[str] = []

    with httpx.Client(timeout=300.0) as c:
        for i, q in enumerate(QUERIES, start=1):
            r = c.post(
                f"{args.api_base}/search",
                json={"collection": args.collection, "query": q,
                      "mode": args.mode, "top_k": args.top_k},
            )
            if r.status_code != 200:
                print(f"[FAIL] q={q!r} status={r.status_code} body={r.text}",
                      file=sys.stderr)
                lines.append(f"| {i} | `{q}` | ❌ ERROR | {r.status_code} |")
                continue

            body = r.json()
            answer = body.get("answer", "") or ""
            chunks = body.get("chunks", []) or []

            detail.append(f"\n---\n## Q{i}: `{q}`\n")
            detail.append(f"**answer:** {answer[:500]}\n")
            detail.append(f"**chunks (top {min(3, len(chunks))}):**")
            for j, ch in enumerate(chunks[:3], start=1):
                txt = (ch.get("text") or "")[:200]
                detail.append(f"  {j}. id=`{ch.get('id')}` score={ch.get('score')}\n     {txt}")
            lines.append(f"| {i} | `{q}` | __ | _grade me_ |")

    out_md = "\n".join(lines) + "\n" + "\n".join(detail) + "\n"
    print(out_md)
    if args.out:
        args.out.write_text(out_md, encoding="utf-8")
        print(f"\nwrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`chmod +x services/rag/scripts/eval_search.py`

- [ ] **Step 3: Syntax check**

```bash
cd services/rag
uv run python -c "import ast; ast.parse(open('scripts/eval_search.py').read()); print('ok')"
```

- [ ] **Step 4: Commit**

```bash
git add services/rag/scripts/eval_search.py \
        docs/superpowers/specs/2026-05-14-phase2a-eval-rubric.md
git commit -m "feat(rag): Phase 2a manual eval harness + rubric (10 fixed queries)"
```

---

### Task 7: Phase 2a Pilot Run (the acceptance gate)

**Files:**
- Create: `docs/superpowers/specs/2026-05-14-phase2a-eval-results.md` (the human-graded output)

**This task is an operational checklist, not a coding task. It produces measured evidence Phase 2a met its three thresholds.**

- [ ] **Step 1: Pre-flight**

```bash
# 1. LM Studio with Qwen3-30B-A3B-Instruct-2507 + nomic-embed-text-v1.5 loaded
curl -s http://127.0.0.1:1234/v1/models | python3 -m json.tool

# 2. DB env vars present
python3 -c "import os; print({k:bool(os.environ.get(k)) for k in ['DWS_DB_HOST','DWS_DB_USER','DWS_DB_PASSWORD','DWS_DB_DATABASE','PAPERCLIP_RAG_INGEST_ACCOUNT']})"

# 3. paperclip-rag service running
cd services/rag && ./scripts/run_dev.sh   # in its own terminal, keep open

# 4. From another terminal: confirm /healthz says lm_studio=up
curl -s http://127.0.0.1:9001/healthz | python3 -m json.tool
```

Expected: all 5 env-var keys are `True`; `/healthz` returns `{"status":"ok","lm_studio":"up", ...}`.

- [ ] **Step 2: Decide --since and run dry-run**

Set the lookback window. Phase 2a is 500 rows — recent enough to be relevant, far enough to have 500 rows. Start with last 90 days:

```bash
SINCE=$(python3 -c "from datetime import date, timedelta; print((date.today() - timedelta(days=90)).isoformat())")
cd services/rag
uv run python -m paperclip_rag.ingest.refund_comments \
    --since "$SINCE" --limit 500 --dry-run
```

Expected: `... total new: 500 (skipped 0)`. If far less than 500, expand `--since` to 180 days. If decisions are needed about which account: ask the user.

- [ ] **Step 3: Real ingest**

```bash
uv run python -m paperclip_rag.ingest.refund_comments \
    --since "$SINCE" --limit 500
```

Expected: runs ~1.1h (per spec §6 estimate of ~8s/chunk × 500 chunks). Watch `_logs/rag/paperclip-rag-<DATE>.log` for progress. If timing exceeds 2h, abort with Ctrl-C; LightRAG's internal state may be salvageable for a partial check.

- [ ] **Step 4: KG threshold check**

```bash
uv run python scripts/inspect_kg.py refund_comments --threshold-entities 100 --threshold-relations 50
```

Expected: exits 0; printed report shows `entity_count >= 100` and `relation_count >= 50`. Eyeball `entities_by_type` distribution — should be dominated by `sku`, `return_reason`, `sizing_issue`, `quality_issue`. If it's dominated by `unknown` or `person`/`geo`, **stop**: the `addon_params.entity_types` override isn't taking effect. Verify in `lightrag_factory.py` and re-ingest.

- [ ] **Step 5: Run manual eval**

```bash
uv run python scripts/eval_search.py \
    --out ../../docs/superpowers/specs/2026-05-14-phase2a-eval-results.md
```

Expected: writes the markdown file with 10 query results + chunks.

- [ ] **Step 6: Grade the results**

Open `docs/superpowers/specs/2026-05-14-phase2a-eval-results.md`. For each of the 10 queries, fill in the Hit/Miss column per the rubric:

- **Hit** = at least 1 of top-3 chunks is on-topic
- **Miss** = none of top-3 are on-topic

Add a one-line note per row explaining the call. Count Hits.

- [ ] **Step 7: Commit results file**

```bash
git add docs/superpowers/specs/2026-05-14-phase2a-eval-results.md
git commit -m "docs(rag): Phase 2a eval results — N/10 hits at $(date +%Y-%m-%d)"
```

(Replace `N` with the actual count in the commit message.)

- [ ] **Step 8: Branch the decision**

- **If Hits ≥ 7/10:** Phase 2a passes. Tag `git tag rag-phase2a-ga`. Write Phase 2b plan (5k batch + prompt/chunk tuning).
- **If Hits 5–6/10:** Borderline. Inspect the misses, decide whether to (a) accept and tune in 2b, or (b) tweak `entity_types`/chunk_size now and re-ingest. Document the call in the results file.
- **If Hits < 5/10:** Phase 2a not done. Diagnose: likely the KG entity_types aren't catching the right concepts, or the embedding model isn't differentiating Chinese complaint text well. Possible actions:
  - Try `bge-m3` embedding instead of nomic (different recall profile).
  - Add more granular entity types (`shipping_damage`, `color_mismatch`, etc.).
  - Add a brief Chinese-tuned chunking prompt.
  - Re-run from Step 3.

---

## Phase 2a Done Criteria (recap)

- [x] manifest.py + 5 tests
- [x] logging_setup.py + 2 tests, wired into FastAPI lifespan
- [x] Embedding-dim startup probe + 3 tests
- [x] refund_comments ingest CLI (env vars, MySQL query, manifest write)
- [x] inspect_kg.py with threshold gates
- [x] eval_search.py + rubric spec
- [x] 500 rows ingested successfully
- [x] KG: entities ≥ 100, relations ≥ 50, entity_types distribution sensible
- [x] Manual eval: ≥ 7/10 queries hit top-3
- [x] All committed; eval results checked in

**Test count at Phase 2a end:** 36 (26 Phase 1 + 5 manifest + 2 logging + 3 dim probe).

Phase 2b plan (5k batch + tuning) will be written after Phase 2a's eval results inform what to tune.

---

## Resolved Decisions

- **Account:** `EverPretty-US` (set via `PAPERCLIP_RAG_INGEST_ACCOUNT=EverPretty-US` in `services/rag/.env`, or pass `--account EverPretty-US`).
- **DB access:** user has SQL Server / DWS query access; `DWS_DB_*` env vars must be exported in the shell that runs the ingest CLI (same env used by `packages/tool-registry/src/tools/dws/_query.py`).
- **Sync vs background ingest:** Phase 2a stays synchronous (single operator, easy ctrl-C). Convert to `/jobs/{job_id}` in Phase 2c (5k overnight).
- **Short-row-count handling:** if `--since 90 days` returns < 500 rows, fail loudly. Operator decides whether to expand window; auto-expansion can pull stale data that distorts eval.
