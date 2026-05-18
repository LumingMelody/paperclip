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
    parser.add_argument(
        "--translate",
        choices=["auto", "off"],
        default="auto",
        help="Forward as SearchRequest.translate. 'off' reproduces Phase 2a baseline.",
    )
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
                      "mode": args.mode, "top_k": args.top_k,
                      "translate": args.translate},
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
            meta = body.get("meta") or {}
            if meta:
                detail.append(
                    f"\n**meta:** translation={meta.get('translation')} "
                    f"translate_ms={meta.get('translate_ms')} "
                    f"translated_query={meta.get('translated_query')!r} "
                    f"fallback_reason={meta.get('fallback_reason')}"
                )
            lines.append(f"| {i} | `{q}` | __ | _grade me_ |")

    out_md = "\n".join(lines) + "\n" + "\n".join(detail) + "\n"
    print(out_md)
    if args.out:
        args.out.write_text(out_md, encoding="utf-8")
        print(f"\nwrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
