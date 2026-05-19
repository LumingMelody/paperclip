# C1: Multilingual Embedding Swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Swap RAG embedding from `nomic-embed-text-v1.5` (768-dim, EN) to `text-embedding-bge-m3` (1024-dim, multilingual). Wipe-and-rebuild storage. Eval to determine whether the Phase 2b-1 translation layer can be retired.

**Architecture:** Two config lines change. Storage tarball backed up, then deleted. Re-ingest into `refund_comments` directly. Eval against the documented Phase 2b-1 baseline (off=7/10, auto=9/10).

**Tech Stack:** Python, FastAPI, LightRAG-HKU, pytest, LM Studio (bge-m3 Q4_K_M GGUF, ~634MB).

**Spec:** `docs/superpowers/specs/2026-05-19-rag-multilingual-embedding-design.md`

**Working dir:** `/Users/melodylu/PycharmProjects/paperclip/services/rag/` unless noted.

**Operator state:** `text-embedding-bge-m3` already loaded in LM Studio (verified: id matches, embed call returns 1024-dim vector). Qwen3-30b also loaded (needed for entity extraction during re-ingest).

---

## File Map

**Modified (T1):**
- `services/rag/src/paperclip_rag/config.py` — `embedding_model` default → `"text-embedding-bge-m3"`, `embedding_dim` default → `1024`
- `services/rag/.env` — same two kv updates
- `services/rag/tests/test_config.py` — update assertions for new defaults
- `services/rag/tests/test_startup_dim_probe.py` — flip `768 → 1024` in both dim constants (pass case becomes 1024/1024, mismatch case becomes 1024/768)

**Modified (T6 — only if eval passes ≥9/10 with translate=off):**
- `services/rag/src/paperclip_rag/schemas.py` — `SearchRequest.translate` default `"auto"` → `"off"`
- `services/rag/tests/test_schemas.py` — assertion update
- `services/rag/tests/test_api.py::test_search_translates_cjk_query` — explicitly pass `translate="auto"` so it still exercises the translator path
- `packages/tool-registry/src/tools/rag/searchRefundComments.ts` — remove "CN is auto-translated" from description

**Operational (T2-T5, no code):**
- `~/.paperclip/lightrag-storage-archive/refund_comments-pre-c1-<ts>.tar.gz` (tarball backup, new)
- `~/.paperclip/lightrag-storage/refund_comments/` (wiped and rebuilt)
- `docs/superpowers/specs/2026-05-19-c1-eval-results.md` (new, eval doc)

---

### Task 1: Config defaults + tests

**Files:** `config.py`, `.env`, `test_config.py`, `test_startup_dim_probe.py`

- [ ] **Step 1: Write failing tests**

Update existing assertions in `tests/test_config.py`. Find the test that asserts defaults (likely `test_settings_default_*` or similar). The OLD assertions look like:

```python
assert s.embedding_model == "nomic-embed-text-v1.5"
assert s.embedding_dim == 768
```

Change to:

```python
assert s.embedding_model == "text-embedding-bge-m3"
assert s.embedding_dim == 1024
```

In `tests/test_startup_dim_probe.py`, find the two dim constants and flip them:
- `test_dim_probe_passes_match`: was `EMBEDDING_DIM=768` with probe returning 768; change BOTH to `1024`.
- `test_dim_probe_rejects_mismatch`: was `EMBEDDING_DIM=768` with probe returning 1024; flip to `EMBEDDING_DIM=1024` with probe returning 768 (still mismatch, different direction).

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_config.py tests/test_startup_dim_probe.py -v`
Expected: FAIL — defaults still 768/nomic in source.

- [ ] **Step 3: Update `config.py`**

Replace the two default values:

```python
class Settings(BaseSettings):
    ...
    llm_model: str = "qwen3-30b-a3b-instruct-2507"
    translation_llm_model: str | None = None
    embedding_model: str = "text-embedding-bge-m3"
    embedding_dim: int = 1024
    ...
```

- [ ] **Step 4: Update `services/rag/.env`**

Two lines change:
```
PAPERCLIP_RAG_EMBEDDING_MODEL=text-embedding-bge-m3
PAPERCLIP_RAG_EMBEDDING_DIM=1024
```

(Leave other env vars alone.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_config.py tests/test_startup_dim_probe.py -v`
Expected: PASS.

- [ ] **Step 6: Run the full non-integration suite**

Run: `uv run pytest -m "not integration" -v 2>&1 | tail -5`
Expected: ~85 passed (Phase 2b-1+A1+A2 baseline). Zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/paperclip_rag/config.py .env tests/test_config.py tests/test_startup_dim_probe.py
git commit -m "feat(rag): config defaults — bge-m3 1024-dim multilingual embedding"
```

---

### Task 2: Restart RAG service + verify dim probe passes against live LM Studio

**Files:** none (operational verification)

- [ ] **Step 1: Restart RAG service**

```bash
pkill -f "uvicorn paperclip_rag" || true
sleep 2
cd /Users/melodylu/PycharmProjects/paperclip/services/rag
./scripts/run_dev.sh > /tmp/rag_c1.log 2>&1 &
sleep 8
curl -s http://127.0.0.1:9001/healthz
```

Expected: `{"status":"ok","lm_studio":"up","collections":[]}` (collections empty until first query loads them).

- [ ] **Step 2: Verify dim probe passed in the log**

Run: `grep "embedding dim probe" /tmp/rag_c1.log`
Expected: line `embedding dim probe passed: 1024`. If it says `768` or `dim mismatch`, STOP and investigate.

- [ ] **Step 3: One-off /search against OLD collection to confirm the mismatch failure mode**

This is intentional — we want to see the assert fire BEFORE we wipe, to confirm the diagnosis from Codex (spec §10):

```bash
rtk proxy curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"做工","top_k":3}' 2>&1 | head -5
```

Expected: 500 response containing `AssertionError` / `embedding_dim` mismatch in stack trace (because the on-disk nano-vectordb is still 768). This confirms we MUST wipe before any /search can succeed.

If somehow this returns 200, the wipe step in T3 can be more relaxed — but expect 500.

---

### Task 3: Backup, wipe, and verify the storage dir state

**Files:** none (filesystem ops)

- [ ] **Step 1: Create archive dir if absent**

```bash
mkdir -p ~/.paperclip/lightrag-storage-archive
```

- [ ] **Step 2: Tarball the existing refund_comments storage**

```bash
TS=$(date +%Y%m%d-%H%M%S)
tar -czf ~/.paperclip/lightrag-storage-archive/refund_comments-pre-c1-${TS}.tar.gz \
  -C ~/.paperclip/lightrag-storage refund_comments
ls -lh ~/.paperclip/lightrag-storage-archive/refund_comments-pre-c1-${TS}.tar.gz
```

Expected: tarball file exists, size on the order of single-digit MB. Note the tarball name for rollback.

- [ ] **Step 3: Wipe the storage dir**

```bash
rm -rf ~/.paperclip/lightrag-storage/refund_comments
ls ~/.paperclip/lightrag-storage/
```

Expected: `refund_comments` is gone. Other collections (if any) untouched.

- [ ] **Step 4: Verify the old collection is unreachable**

Re-run the same /search probe from T2 Step 3:

```bash
rtk proxy curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"做工","top_k":3}' 2>&1 | head -10
```

Expected: 500 / KG-not-initialized / empty answer / similar — confirms storage gone, ready for re-ingest.

---

### Task 4: Re-ingest 380 docs with bge-m3

**Files:** none (CLI invocation)

This is the LONG-RUNNING step. ~1-2h expected. Run in background; monitor via log tail.

- [ ] **Step 1: Confirm DWS credentials still exported**

Run: `env | grep -E "DWS_DB_" | head -5`
Expected: HOST/USER/PASSWORD/DATABASE all set. If empty:

```bash
export DWS_DB_HOST=rm-bp1dm282ayh5203tngo.mysql.rds.aliyuncs.com
export DWS_DB_PORT=3306
export DWS_DB_USER=DW_AI_READ_ONLY
export DWS_DB_PASSWORD=epai@123456
export DWS_DB_DATABASE=everpretty
```

(Per memory `paperclip-rag-account.md`.)

- [ ] **Step 2: Run the ingest in background**

```bash
cd /Users/melodylu/PycharmProjects/paperclip/services/rag
nohup uv run python -m paperclip_rag.ingest.refund_comments \
  --collection refund_comments \
  --account EverPretty-US \
  --since 2024-01-01 \
  --limit 500 \
  > /tmp/c1_ingest.log 2>&1 &
echo "started pid=$!"
```

Why `--limit 500`: matches Phase 2a's original ingest. Will dedup down to ~380 unique docs.

- [ ] **Step 3: Monitor**

Tail every few minutes:
```bash
tail -30 /tmp/c1_ingest.log
```

Look for `inserted 380 docs into LightRAG` or similar terminal message. If it hangs >2h, the LM Studio embedding might be misconfigured; check `curl /v1/embeddings` directly.

- [ ] **Step 4: Verify collection rebuilt**

After ingest completes:
```bash
rtk proxy curl -s -X POST http://127.0.0.1:9001/search \
  -H 'content-type: application/json' \
  -d '{"collection":"refund_comments","query":"做工质量","top_k":5}' \
  > /tmp/c1_post_ingest.json
rtk proxy jq '{n_chunks: (.chunks | length), n_entities: (.entities | length), n_relations: (.relations | length), translation: .meta.translation, answer_head: .answer[0:120]}' /tmp/c1_post_ingest.json
```

Pass: `n_chunks > 0`, `n_entities > 0`, `n_relations > 0`. (`translation` will be whatever defaults to — for now still `"translated"` since we haven't flipped T6 yet.)

- [ ] **Step 5: Commit no code change here, but document the ingest in a small ops note**

(Optional — skip if you'd rather defer to T6 eval doc.)

---

### Task 5: Run side-by-side eval — translate=off vs translate=auto

**Files:** `/tmp/c1_eval_off.md`, `/tmp/c1_eval_auto.md` (script outputs)

- [ ] **Step 1: Run with translate=off (testing whether bge-m3 alone is sufficient)**

```bash
cd /Users/melodylu/PycharmProjects/paperclip/services/rag
uv run python scripts/eval_search.py --translate off --out /tmp/c1_eval_off.md
echo "exit=$?"
```

Wait until done (~5-10 min for 10 queries).

- [ ] **Step 2: Run with translate=auto (testing whether translation still helps)**

```bash
uv run python scripts/eval_search.py --translate auto --out /tmp/c1_eval_auto.md
echo "exit=$?"
```

- [ ] **Step 3: Read both files and grade manually**

```bash
wc -l /tmp/c1_eval_off.md /tmp/c1_eval_auto.md
head -20 /tmp/c1_eval_off.md
head -20 /tmp/c1_eval_auto.md
```

For each of the 10 queries, classify HIT/MISS using the same rubric as Phase 2b-1 eval results doc (substantive answer with real customer quotes = HIT; "未提及" / "无法确认" / placeholder content = MISS).

Tabulate side-by-side:
```
| Q  | Phase 2b-1 off | Phase 2b-1 auto | C1 off | C1 auto |
|----|---------------|-----------------|--------|---------|
| 1  | HIT           | HIT             | ?      | ?       |
| 2  | HIT           | HIT             | ?      | ?       |
| 3  | MISS          | HIT             | ?      | ?       |   <- key test: does bge-m3 alone fix Q3?
| 9  | MISS          | MISS            | ?      | ?       |   <- true negative; can't fix with embedding
| 10 | MISS          | HIT             | ?      | ?       |   <- key test
...
```

---

### Task 6: Write eval results doc + decide translate default

**Files:**
- Create: `docs/superpowers/specs/2026-05-19-c1-eval-results.md`

- [ ] **Step 1: Write the eval doc**

Follow the same shape as `docs/superpowers/specs/2026-05-18-phase2b1-eval-results.md`. Include:
- Headline table (off vs auto, total HIT counts, delta vs Phase 2b-1)
- Per-query table with all 4 columns (Phase 2b-1 off/auto, C1 off/auto)
- Conclusion: does C1 alone hit ≥9/10 (deprecates translation layer)? Or is C1 a quality bump only (keep translation)?
- Notes for any specific queries where behavior changed direction

- [ ] **Step 2: Decide based on result**

| Result | T7 action |
|---|---|
| C1 off ≥9/10 | Flip `SearchRequest.translate` default to `"off"` (T7). Translation layer becomes deprecated. |
| C1 off 8/10, C1 auto ≥9/10 | Keep `translate=auto` default. C1 ships as a quality bump. Document in eval doc. |
| C1 off <7/10 | Rollback (restore tarball, revert config commit). Should not happen if bge-m3 is reasonable. |

- [ ] **Step 3: Commit**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
git add docs/superpowers/specs/2026-05-19-c1-eval-results.md
git commit -m "docs(c1): bge-m3 eval results — N/10 off, M/10 auto"
```

---

### Task 7: Conditional default flip (ONLY if eval shows C1 off ≥9/10)

**Files:** `schemas.py`, `test_schemas.py`, `test_api.py`, `packages/tool-registry/src/tools/rag/searchRefundComments.ts`

- [ ] **Step 1: Flip default in schemas.py**

In `services/rag/src/paperclip_rag/schemas.py`, change:

```python
class SearchRequest(BaseModel):
    ...
    translate: Literal["auto", "off"] = "off"  # was "auto"
```

- [ ] **Step 2: Update test_schemas.py**

Find `test_search_request_translate_default_*` tests and update the expected value from `"auto"` to `"off"`.

- [ ] **Step 3: Update test_api.py::test_search_translates_cjk_query**

Make it explicit so it still exercises the translation path:

```python
r = client.post(
    "/search",
    json={"collection": "decisions", "query": "退货率", "translate": "auto"},
    #                                                   ^^^^^^^^^^^^^^^^^^^^ added
)
```

(Same change for `test_search_meta_for_fallback` which currently relies on `translate=auto` default to trigger the translator.)

- [ ] **Step 4: Update B1 tool description**

In `packages/tool-registry/src/tools/rag/searchRefundComments.ts`, find the description string containing "CN is auto-translated". Replace with: "CN queries are embedded directly via the multilingual bge-m3 model — no translation step needed."

Rebuild tool-registry:
```bash
pnpm --filter @paperclipai/tool-registry build
```

- [ ] **Step 5: Verify**

Run: `uv run pytest -m "not integration" -v 2>&1 | tail -5`
Expected: all green (~85).

- [ ] **Step 6: Commit**

```bash
git add services/rag/src/paperclip_rag/schemas.py services/rag/tests/test_schemas.py services/rag/tests/test_api.py packages/tool-registry/src/tools/rag/searchRefundComments.ts packages/tool-registry/dist/tools/rag/searchRefundComments.js
git commit -m "feat(rag,b1): default translate=off — bge-m3 handles CN natively"
```

---

### Task 8: Tag + final summary

- [ ] **Step 1: Tag**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
git tag -a rag-c1-multilingual-embedding-ga -m "C1 GA: multilingual bge-m3 embedding

Replaced nomic-embed-text-v1.5 (768-dim, EN) with bge-m3 (1024-dim,
multilingual). Wipe-and-rebuild storage from 380 refund_comments docs.

Eval (see 2026-05-19-c1-eval-results.md):
- translate=off: <N>/10 HIT (Phase 2b-1 baseline: 7/10)
- translate=auto: <M>/10 HIT (Phase 2b-1 baseline: 9/10)
- Default translate: <off|auto>

Spec: docs/superpowers/specs/2026-05-19-rag-multilingual-embedding-design.md
Plan: docs/superpowers/plans/2026-05-19-rag-multilingual-embedding.md"
```

- [ ] **Step 2: Summary**

```bash
git log --oneline master..HEAD
```

Expected commits in order:
1. `docs(c1): RAG multilingual embedding swap — design`
2. `docs(c1): RAG multilingual embedding — implementation plan`
3. `feat(rag): config defaults — bge-m3 1024-dim multilingual embedding`
4. `docs(c1): bge-m3 eval results — N/10 off, M/10 auto`
5. (conditional T7) `feat(rag,b1): default translate=off — bge-m3 handles CN natively`

---

## Self-Review

**Spec coverage:**
- §3 model choice → Task 0 (operator prereq, done before T1)
- §3 storage strategy + backup → Task 3
- §3 LM Studio id matching → Task 2 (verify in healthz log)
- §3 A/B against Phase 2b-1 baseline (not in-process) → Task 5+6
- §4 file changes → Task 1 (T1) + Task 7 (T7 conditional)
- §5 outline matches Tasks 1-8
- §6 error scenarios — handled by Tasks 2 (mismatch fires), 3 (wipe assert), 4 (re-ingest crash recovery)
- §7 unit tests → Task 1 (test_config + test_startup_dim_probe)
- §8 acceptance criteria 1-9 → Tasks 1, 2, 4 (chunks > 0), 5 (eval), 6 (results doc), 7 (default flip), 8 (tag)
- §9 rollback (tarball, config revert) → Task 3 (backup), Task 6 (decision matrix)
- §10 operator prereqs → already done (model loaded)

**Placeholder scan:** No TBD. Every command is concrete. Eval grading is manual but the rubric reference is given.

**Type/name consistency:**
- `text-embedding-bge-m3` consistent (matches LM Studio).
- `1024` consistent across config + tests + env.
- `refund_comments` collection name reused — no `_bge` suffix anywhere.
