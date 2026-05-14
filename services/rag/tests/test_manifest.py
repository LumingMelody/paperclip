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
