# C1: Multilingual Embedding Swap — Design

**Status:** Draft for review
**Date:** 2026-05-19
**Owner:** Paperclip RAG team
**Related:**
- Phase 2b-1 (`2026-05-18-cn-en-query-translation-design.md`) — translation layer was the patch; C1 is the root-cause fix
- Phase 2b-1 eval (`2026-05-18-phase2b1-eval-results.md`) — 9/10 HIT achieved via translation; can multilingual embedding match this WITHOUT translation?
- A1 (`2026-05-19-rag-chunks-empty-fix-design.md`) — surfaces `chunks[]` so we can see WHICH chunks the new embedding pulls

---

## 1. Context & Motivation

The current embedding stack is **English-centric**:
- Model: `nomic-embed-text-v1.5` (768-dim, English-trained)
- Corpus: refund_comments are ~99% English customer text
- Queries: Chinese (operations / product / brand teams)

Phase 2b-1 worked around this by inserting a CN→EN translation layer in front of `aquery_llm`. It works (7/10 → 9/10) but it's a patch with real costs:
- Extra LLM call per CJK query (200-500ms p50, occasional fallbacks)
- One more failure mode in the request path
- Doesn't help non-Chinese-non-English queries (Spanish, Italian, etc. — see real refund_comments from EP-UK/EU markets)
- Doesn't help when query mixes CN + EN ambiguously

**C1's hypothesis:** swap to a multilingual embedding model (bge-m3) so CN queries embed in the same vector space as EN chunks directly. If the eval reaches ≥9/10 with `translate=off` after the swap, **Phase 2b-1's translation layer becomes dead code we can delete later** (separate cleanup spec).

**Out of scope (deferred):**
- Removing the translation layer (only after C1 proves it's redundant)
- Multi-account ingest (B2 — independent)
- Setting `file_path` during ingest (would fix `references[]` empty but is B2's territory)
- Sparse/ColBERT retrieval (bge-m3 supports both but LightRAG only consumes dense vectors today)

---

## 2. Model Choice: `bge-m3`

| Model | Dim | Params | MTEB CN+EN avg | Notes |
|---|---|---|---|---|
| `bge-m3` (BAAI) | **1024** | 568M | strong leader | Dense + sparse + colbert, multilingual (100+ langs), 8K context |
| `multilingual-e5-large` (Microsoft) | 1024 | 560M | close 2nd | Multilingual, slightly weaker on CN-heavy retrieval |
| `paraphrase-multilingual-mpnet-base-v2` | 768 | 278M | weaker | Smaller, would let us keep `embedding_dim=768` — but quality gap not worth the dim convenience |
| `nomic-embed-text-v1.5` (current) | 768 | 137M | English-only | Cheap, fast, doesn't speak Chinese |

**Decision: `bge-m3`.** SOTA quality, M4 Max can run 568M params easily, 1024-dim only requires updating two config lines and one storage wipe.

LM Studio model identifier (when downloaded): `bge-m3` or `bge-m3-GGUF` — exact id depends on which quant the user picks during download.

---

## 3. Decisions

| Question | Decision |
|---|---|
| Model | `bge-m3` (1024-dim) |
| LM Studio quant | User chooses during download. Q4_K_M (3.6GB) is a safe default; Q8_0 (6.2GB) for slightly better quality if disk/RAM tolerates. The spec doesn't enforce a specific quant since the LM Studio HTTP API is quant-agnostic. |
| **LM Studio model id matching (Codex catch — RED)** | LM Studio's HTTP API uses EXACT id matching, not substring (`lm_studio.py:61-83` passes `embedding_model` verbatim into the `model` field, and `/v1/models` check is `m not in loaded` exact set). Operator MUST `curl /v1/models | jq` after download and copy the exact id (e.g. `bge-m3` vs `text-embedding-bge-m3-q4_k_m` vs `BAAI/bge-m3`) into `PAPERCLIP_RAG_EMBEDDING_MODEL`. Spec defaults to literal `"bge-m3"` only as a placeholder; operator override in `.env` is the source of truth. |
| Storage strategy | Wipe-and-rebuild. Delete `~/.paperclip/lightrag-storage/refund_comments/` and re-ingest the 380 docs with bge-m3. bge-m3 1024-dim vectors are incompatible with existing nomic 768-dim nano-vectordb files. |
| Backup-before-wipe | YES. Tarball the old storage dir to `~/.paperclip/lightrag-storage-archive/refund_comments-pre-c1-<timestamp>.tar.gz` before deletion. ~5MB compressed; cheap insurance. **The archive directory does NOT auto-create** — T4 must `mkdir -p` first. |
| **A/B validation strategy (Codex catch — RED)** | The original "side-by-side single-service" idea is impossible: `embedding_dim` is a process-level Setting, and once we flip to 1024 the old 768 nano-vectordb fails its `assert storage["embedding_dim"] == self.embedding_dim` (nano_vectordb/dbs.py:71) on first read in the same process. **Revised strategy:** no in-process A/B. The baseline IS the Phase 2b-1 eval results (`2026-05-18-phase2b1-eval-results.md`) — already documented at 7/10 off, 9/10 auto. C1 eval is a single forward run against the new bge-m3 collection; compare numerically to the documented baseline. If we genuinely need a live A/B later, that means running two RAG processes on different ports with different `.env` files — out of scope for C1. |
| Re-ingest collection name | `refund_comments` directly (NOT `refund_comments_bge`). Wipe the old, rebuild in-place. No rename step needed. |
| Translation layer | Leave installed but disabled by default after C1: change `SearchRequest.translate` default from `"auto"` to `"off"`. Code stays for rollback / future use; behavior changes. Translation layer removal is a separate cleanup spec, not part of C1. |
| Eval methodology | Run Phase 2a 10-query rubric with `--translate off` against the new bge-m3 collection. Pass criterion: ≥9/10 HIT (matches Phase 2b-1's translated baseline). Stretch: ≥8/10 means swap is still a win even if translation contributed something. <7/10 means rollback. |
| Translation layer disable timing | Apply AFTER eval passes — do not disable preemptively. If eval shows `translate=off` < 9/10 but `translate=auto` ≥ 9/10, KEEP `translate=auto` as default (C1 ships as a quality bump on top of Phase 2b-1, not a replacement). |
| **B1 tool description update (Codex catch — RED-ish)** | If the default flip happens (translate→off), the B1 tool's description string at `packages/tool-registry/src/tools/rag/searchRefundComments.ts` ("CN is auto-translated") becomes misleading. Update it as part of T7's flip commit. |

---

## 4. Architecture

### 4.1 Files touched

| File | Change | Lines |
|---|---|---|
| `services/rag/src/paperclip_rag/config.py` | Update `embedding_model` default to `"bge-m3"`, `embedding_dim` default to `1024` | 2 |
| `services/rag/.env` | Same kv updates so the running service picks them up | 2 |
| `services/rag/scripts/run_dev.sh` | Add a comment block above the uvicorn line listing the multilingual model prerequisite (no logic change) | +3 (comment-only) |
| `services/rag/tests/test_config.py` | Update embedding defaults in the assertion (one line) | 1 |
| `services/rag/tests/test_startup_dim_probe.py` | Update the `embedding_dim` constant in mocked probe to 1024 | 1 |
| `services/rag/src/paperclip_rag/schemas.py` | Change `SearchRequest.translate` default from `"auto"` to `"off"` — ONLY after eval passes (see §6 step 7) | 1 |
| `services/rag/tests/test_schemas.py` | Update the `test_search_request_translate_default_*` assertions | ~5 |
| `services/rag/tests/test_api.py` | Same — assertion updates for the new default | ~5 |
| `docs/superpowers/specs/2026-05-19-c1-eval-results.md` | New file with eval results in same shape as Phase 2b-1 eval results | +100 |

**Side-by-side ingest re-run** is operational, not code. `services/rag/src/paperclip_rag/ingest/refund_comments.py` is unchanged — it already accepts a `--collection` arg.

### 4.2 Why no code change to LightRAGFactory

The factory already reads `embedding_dim` and `embedding_model` from `Settings`, builds `EmbeddingFunc`, and passes it into `LightRAG(...)`. All we need is for those settings values to change. The dim probe at startup (`api.py:64-71`) validates that LM Studio actually serves 1024-dim — that's our safety net for "user forgot to load bge-m3 in LM Studio".

### 4.3 No factory restart fragility

Switching the embedding model requires LightRAG's storage to be rebuilt from scratch — we don't ship a migration. The C1 plan does the wipe explicitly + verifies with healthz before re-ingest. Once the new storage exists, the service runs normally.

---

## 5. Implementation Plan Outline

(Full TDD steps in the writing-plans output. Sketch here so reviewers can see the shape.)

1. **T1**: Update config defaults (model + dim) + tests. Run pytest, expect green except for the dim-probe (which now mismatches because LM Studio still serves nomic 768-dim).
2. **T2**: Manual: user downloads bge-m3 in LM Studio, loads it. Spec instructs which actions to take in LM Studio UI.
3. **T3**: Update `.env` to match config + restart RAG service. Healthz dim probe must pass (1024).
4. **T4**: Backup + wipe old storage. Side-by-side: re-ingest into `refund_comments_bge` collection (keep old `refund_comments` alive for the comparison run).
5. **T5**: Eval — run `scripts/eval_search.py --collection refund_comments_bge --translate off --out /tmp/eval_c1_off.md` and `--translate auto --out /tmp/eval_c1_auto.md`. Grade both manually against the Phase 2a 10-query rubric.
6. **T6**: Write `2026-05-19-c1-eval-results.md` with the side-by-side numbers.
7. **T7 (only if eval ≥9/10 with `translate=off`)**: Change `SearchRequest.translate` default to `"off"`. Rename `refund_comments_bge` → `refund_comments` (after backing up the new one). Tag.
8. **T7 (alternative — if eval <9/10 with `translate=off` but ≥9/10 with `translate=auto`)**: Keep `translate=auto` default. Still rename `refund_comments_bge` → `refund_comments`. Tag. Translation layer stays; bge-m3 is a quality bump but not a translation replacement.
9. **T7 (rollback — if eval <7/10)**: Restore old storage tarball, revert config commits, do NOT tag.

---

## 6. Error Handling

| Scenario | Behavior |
|---|---|
| User doesn't download bge-m3 in LM Studio | LM Studio HTTP API returns nothing for the new id. RAG service: startup dim probe **soft-fails** if LM Studio is unreachable (`api.py:79-82`); but if LM Studio IS reachable and the model id doesn't exist, the probe will fail at request time (any /search query triggers the embed call which gets "model not found"). Hard error surfaces on first /search — clear stack trace. **Verify before re-ingest:** `curl -s http://127.0.0.1:1234/v1/models | jq '.data[].id'` should list the exact id you put in `.env`. |
| LM Studio model id mismatch (substring, wrong quant suffix, etc.) | Embed call returns 404 / "model not found"; ingest CLI surfaces this immediately. Operator fixes `.env` to the exact id and re-runs. |
| Re-ingest crashes partway | Storage was already wiped — `refund_comments` collection partially built. Options: (a) re-run ingest CLI (it's idempotent on `(account, since)` window — see ingest/refund_comments.py); (b) restore from tarball backup. T4 documents both. |
| First /search after deploy hits the old 768 nano-vectordb files (impossible if wipe was clean) | nano_vectordb assert: `assert storage["embedding_dim"] == self.embedding_dim` raises `AssertionError`. If this fires, the wipe was incomplete — `rm -rf` the collection dir and re-ingest. |
| Eval drops to <7/10 | Rollback: restore tarball, revert config commits, restart service. The translation layer (Phase 2b-1) is still installed and active, so user experience returns to Phase 2b-1's 9/10 baseline. |
| `aquery_llm` itself errors after bge-m3 swap | A1's `_extract_answer` + 503 path still works — LightRAG's API contract is unchanged. Only the embeddings inside have changed. |
| B1 tool query during the C1 window (between wipe and re-ingest finishing) | Returns empty chunks/entities until ingest completes. **Mitigation:** announce a maintenance window of ~1-2h during T4; or just accept the temporary regression (B1 will surface `chunks: []` and the bot Claude will work from the answer text alone). |

---

## 7. Testing Strategy

### 7.1 Unit tests (touched in T1)

- `test_config.py`: `Settings().embedding_model == "bge-m3"`, `embedding_dim == 1024`
- `test_startup_dim_probe.py`: file has TWO existing tests with hardcoded `PAPERCLIP_RAG_EMBEDDING_DIM=768`:
  - `test_dim_probe_passes_match` — currently `768 vs 768`; update to `1024 vs 1024`
  - `test_dim_probe_rejects_mismatch` — currently `768 vs 1024`; update to `1024 vs 768` (still a mismatch, just direction-flipped so the post-C1 happy-path is the new dim) — RuntimeError still expected
  - `test_dim_probe_skipped_when_lm_studio_down` — no dim assertion; leaves alone
- `test_schemas.py`: if T7 fires, the `test_search_request_translate_default_*` tests assert against `"auto"` — update to `"off"`. If T7 does NOT fire (eval insufficient), no change.
- `test_api.py::test_search_translates_cjk_query` — uses default `translate="auto"` to exercise the translation path. If T7 fires (default flips to off), this test must explicitly pass `translate="auto"` in its request JSON so it still exercises the translator. Same for any other test that implicitly relied on the auto default.

No new unit tests. The substantive validation is the eval.

### 7.2 Integration test marker

`tests/test_query_translator_prompt.py` (Phase 2b-1's prompt regression suite) is unaffected — it doesn't touch embeddings. No changes.

### 7.3 Manual smoke / eval

The actual validation is the side-by-side eval (T5). Pass/fail criteria are in §3 row "Eval methodology".

Additionally: a one-shot CN query against bge-m3 with `translate=off` should return non-empty results:
```bash
rtk proxy curl -s -X POST http://127.0.0.1:9001/search \
  -d '{"collection":"refund_comments_bge","query":"做工质量","translate":"off","top_k":5}' \
  | jq '{chunks: (.chunks | length), translation: .meta.translation}'
```
Expected: `chunks > 0`, `translation: "passthrough"`. Pre-C1 with translate=off would have returned `chunks == 0` (or chunks unrelated to the topic) because Chinese query couldn't reach English chunks.

---

## 8. Acceptance Criteria

| # | Criterion | Verification |
|---|---|---|
| 1 | All non-integration tests pass after T1 config update | `uv run pytest -m "not integration" -v` |
| 2 | RAG service starts cleanly with bge-m3 loaded in LM Studio | `curl /healthz` returns ok |
| 3 | Re-ingest into `refund_comments_bge` collection succeeds; KG built with non-zero entities/chunks | `curl /search ... | jq '.entities \| length' > 0` |
| 4 | A side-by-side smoke CN query returns chunks with `translate=off` against new collection | manual curl per §7.3 |
| 5 | Eval result documented in `2026-05-19-c1-eval-results.md` with both `translate=off` and `translate=auto` runs | file exists, committed |
| 6 | Eval HIT count meets at least one of: (a) ≥9/10 with translate=off (C1 alone suffices), (b) ≥9/10 with translate=auto (C1 is quality bump on top of Phase 2b-1) | manual grading |
| 7 | If 6(a) holds: `SearchRequest.translate` default flipped to `"off"`; B1 tool path still works | T7 |
| 8 | New collection renamed to `refund_comments` (post-validation cleanup); old archived | manual ops |
| 9 | Tag: `rag-c1-multilingual-embedding-ga` (local) | `git tag -l rag-c1-*` |

---

## 9. Rollback

The wipe-and-rebuild is the riskiest single step. Mitigations:

- **Tarball backup created at T4 step 1, before any deletion.** Restoration: `tar -xzf ~/.paperclip/lightrag-storage-archive/refund_comments-pre-c1-<timestamp>.tar.gz -C ~/.paperclip/lightrag-storage/` and revert the config commits.
- **Side-by-side collections during validation.** Until T7 final rename, the OLD `refund_comments` directory still exists alongside the new `refund_comments_bge`. Cutover is one atomic rename. If we cold-feet at the last moment, the old collection is just a directory rename away.
- **Service-state revert is one config edit + restart.** Edit `.env` back to `EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5` and `EMBEDDING_DIM=768`, restart, point to old collection. No code revert needed for fast emergency back-out (config-only).

No data migration. The DWS source database is untouched throughout — we're rebuilding the LightRAG knowledge graph view of that data.

---

## 10. Resolved Pre-Implementation Verifications

- **`embedding_dim` is read into `EmbeddingFunc`** at `lightrag_factory.py:152-156`; changing the Setting propagates correctly through factory.
- **Startup dim probe behavior (Codex correction):** the probe HARD-fails only when LM Studio is UP and returns the wrong dim (`api.py:64-71`). When LM Studio is unreachable at startup, it SOFT-fails and lets the service boot (`api.py:79-82`). So "service won't start without bge-m3 loaded" is wrong — what's true is "first /search query will error if the model id is wrong / unloaded."
- **Ingest CLI accepts `--collection` arg** (verified at `services/rag/src/paperclip_rag/ingest/refund_comments.py:131`). Used in this spec only to control where the new collection writes.
- **LM Studio model id is exact-match, not substring (Codex catch):** `lm_studio.py:61-83` passes `embedding_model` verbatim into the `/v1/embeddings` `model` field, and `/v1/models` loaded-set check uses `m not in loaded` (exact). Operator must look up the exact id with `curl /v1/models | jq '.data[].id'` after LM Studio download and put it in `.env`.
- **B1 tool hard-codes `collection: "refund_comments"`** at `packages/tool-registry/src/tools/rag/searchRefundComments.ts:55`. We re-ingest INTO that same collection (no _bge suffix), so B1 keeps working post-deploy. During the wipe-and-rebuild window, B1 calls will get empty results until ingest completes.
- **LightRAG storage layout**: each `LightRAG(working_dir=...)` writes one collection's worth of nano-vectordb + jsonl files into that dir. Wiping = `rm -rf <dir>`, no other system state.
- **`embedding_dim` is process-global (Codex catch — RED for the original A/B plan):** nano_vectordb asserts `storage["embedding_dim"] == self.embedding_dim` on load (nano_vectordb/dbs.py:71). Once the running process is configured for 1024, any old 768 storage in the same process raises AssertionError. Revised spec drops in-process A/B entirely.
- **bge-m3 dim confirmed 1024** via HuggingFace model card (BAAI/bge-m3).
- **Archive directory must be explicitly created (Codex catch):** `~/.paperclip/lightrag-storage-archive/` doesn't auto-create; T4 step 1 must `mkdir -p`.
- **B1 tool description string contains "CN is auto-translated"** at `searchRefundComments.ts` description block. Must update if T7 flips translate default to off.

---

## 11. Operator Prerequisites (Manual)

Before T2:
1. Open LM Studio.
2. Search for `bge-m3` in the model browser.
3. Download a GGUF quant (Q4_K_M recommended for the dim/quality balance; Q8_0 if you want slightly better quality and disk allows).
4. Load it via the LM Studio UI (or let auto-load handle it on first request).
5. Confirm the model id with: `curl -s http://127.0.0.1:1234/v1/models | jq '.data[] | select(.id | test("bge"; "i")) | .id'`
6. Set `PAPERCLIP_RAG_EMBEDDING_MODEL` to that exact id in `services/rag/.env`.

The plan's T2 just verifies that this happened — it doesn't perform the download itself (impossible from a CLI agent).
