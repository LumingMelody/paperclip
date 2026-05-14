# paperclip-rag

Local RAG service for paperclip. See `docs/superpowers/specs/2026-05-13-paperclip-rag-design.md`.

## Quickstart

```bash
cd services/rag
uv sync --extra dev
cp .env.example .env             # adjust as needed
./scripts/run_dev.sh              # → http://127.0.0.1:9001
```

## Tests

```bash
uv run pytest                     # unit only
uv run pytest -m integration      # needs LM Studio loaded
```

## Ingest

```bash
uv run python -m paperclip_rag.ingest.decisions \
    --jsonl ../../decisions.jsonl
```

## E2E canary

```bash
./scripts/test_e2e.py             # exits 0 on success
```
