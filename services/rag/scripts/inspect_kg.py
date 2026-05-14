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
