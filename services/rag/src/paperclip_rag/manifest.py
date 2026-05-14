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
