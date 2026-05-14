"""Ingest decisions.jsonl into the `decisions` LightRAG collection.

Each line in decisions.jsonl is one decision object. We concatenate the
human-readable fields into a single text body and use the object's `id`
(or a hash fallback) as the source_id.

Usage:
    uv run python -m paperclip_rag.ingest.decisions \\
        --jsonl ../../decisions.jsonl \\
        [--api-base http://127.0.0.1:9001] \\
        [--dry-run]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import httpx
from loguru import logger


_TEXT_FIELDS = (
    "title",
    "decision",
    "rationale",
    "reason",
    "context",
    "summary",
    "body",
    "text",
    "issues",
)


def _row_to_text(obj: dict[str, Any]) -> str:
    parts: list[str] = []
    for k in _TEXT_FIELDS:
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            parts.append(f"{k}: {v.strip()}")
        elif isinstance(v, list) and v and all(isinstance(x, str) for x in v):
            parts.append(f"{k}: {', '.join(v)}")
    if not parts:
        parts.append(json.dumps(obj, ensure_ascii=False))
    return "\n".join(parts)


def _row_id(obj: dict[str, Any]) -> str:
    for k in ("id", "decision_id", "uuid", "key"):
        v = obj.get(k)
        if isinstance(v, str) and v:
            return v
    digest = hashlib.sha256(
        json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return f"sha256:{digest[:16]}"


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                logger.error("decisions.jsonl line {}: {}", i, e)
                raise
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jsonl", type=Path, required=True)
    parser.add_argument("--api-base", default="http://127.0.0.1:9001")
    parser.add_argument("--collection", default="decisions")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if not args.jsonl.exists():
        logger.error("file not found: {}", args.jsonl)
        return 2

    rows = load_rows(args.jsonl)
    docs = [
        {
            "id": _row_id(r),
            "text": _row_to_text(r),
            "metadata": {"source": "decisions.jsonl", "ts": r.get("ts")},
        }
        for r in rows
    ]
    logger.info("loaded {} rows from {}", len(docs), args.jsonl)

    if args.dry_run:
        for d in docs[:3]:
            print(json.dumps(d, ensure_ascii=False))
        print(f"... total {len(docs)}")
        return 0

    payload = {"collection": args.collection, "docs": docs, "upsert": True}
    with httpx.Client(timeout=600.0) as client:
        r = client.post(f"{args.api_base}/index", json=payload)
    if r.status_code >= 300:
        logger.error("ingest failed: {} {}", r.status_code, r.text)
        return 1
    logger.info("ingested: {}", r.json())
    return 0


if __name__ == "__main__":
    sys.exit(main())
