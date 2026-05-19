# C1 Eval Results — Multilingual Embedding (bge-m3)

**Date:** 2026-05-19
**Spec:** `2026-05-19-rag-multilingual-embedding-design.md`
**Plan:** `../plans/2026-05-19-rag-multilingual-embedding.md`
**Branch:** `c1-multilingual-embedding`
**Embedding swap:** `nomic-embed-text-v1.5` (768d, EN-centric) → `text-embedding-bge-m3` (1024d, multilingual)
**Re-ingest:** 500 rows fetched → 407 unique docs (vs Phase 2a's 380; same DWS source, slightly different dedup window)
**KG build:** 735 entities + 1131 relations (vs Phase 2a 668 / 1051)
**Eval method:** Phase 2a 10-query fixed rubric, both `--translate off` and `--translate auto` runs. Raw outputs at `/tmp/c1_eval_off.md` and `/tmp/c1_eval_auto.md`.

---

## Headline

| Run | HIT | MISS | Score | Comment |
|---|---|---|---|---|
| `--translate off` (bge-m3 alone) | 9 | 1 | **9/10** ✅ | **Matches Phase 2b-1's translated baseline WITHOUT translation** |
| `--translate auto` (bge-m3 + translation) | 9 | 1 | **9/10** | Same — translation provides no additional lift over bge-m3 |
| Phase 2b-1 `--translate off` (nomic baseline) | 7 | 3 | 7/10 | Q3 / Q9 / Q10 MISS |
| Phase 2b-1 `--translate auto` | 9 | 1 | 9/10 | Q3 / Q10 flipped by translation; Q9 stays MISS |

**Key finding:** bge-m3's multilingual embedding **alone** flips Q3 (物流损坏) and Q10 (异味) from MISS to HIT without any translation step. This means the Phase 2b-1 translation layer is redundant for our refund_comments corpus — root-cause fixed.

Q9 (没收到 物流丢失) remains MISS across all four runs. It's a confirmed true negative: the 380-407 doc sample has no genuine lost-shipment data. Not a retrieval failure.

---

## Per-Query Side-by-Side

| # | Query | 2b-1 off | 2b-1 auto | **C1 off** | **C1 auto** | Notes |
|---|---|---|---|---|---|---|
| 1 | `偏小 升一码` | ✅ | ✅ | ✅ | ✅ | All four runs cite multiple Too Small SKUs with specifics |
| 2 | `偏大 降一码` | ✅ | ✅ | ✅ | ✅ | C1 cites EP07886NB12B / EE0164A specifically; consistent quality |
| 3 | `物流损坏 包装` | ❌ | ✅ | ✅ | ✅ | **C1 off flipped**: cites `DAMAGED_BY_FC` SKU `ES80026DG04-PH` with "Dark spot on it (ink?), Front" — exact match to a real chunk. bge-m3 reached this English chunk from the Chinese query directly. |
| 4 | `做工 缝线 质量` | ✅ | ✅ | ✅ | ✅ | C1 answer goes deeper on specific defects (stitching cap sleeves coming apart, EE02960BD14-USA) |
| 5 | `颜色差 色差` | ✅ | ✅ | ✅ | ✅ | C1 enumerates color codes (TE, DG, DP, CH, OD, BD, GD) explicitly |
| 6 | `不符合描述 与图片不符` | ✅ | ✅ | ✅ | ✅ | Consistent NOT_AS_DESCRIBED citation across runs |
| 7 | `EG02084` | ✅ | ✅ | ✅ | ✅ | Pure-English SKU query — embedded directly in both modes |
| 8 | `Amazon 退货` | ✅ | ✅ | ✅ | ✅ | Consistent across runs; categorical breakdown |
| 9 | `没收到 物流丢失` | ❌ | ❌ | ❌ | ❌ | **True negative.** Sample has delivery-delay events (MISSED_ESTIMATED_DELIVERY) but no genuine lost-shipment events. Independent of embedding choice. |
| 10 | `异味 味道大` | ❌ | ✅ | ✅ | ✅ | **C1 off flipped**: cites EE01888BK10-USA "Too big and it smells terrible" and ES0106BMU16-USA "white pet hair... smells" — same evidence used by 2b-1 auto, but C1 reaches it without translation. |

---

## Translation Layer Telemetry (C1 auto run)

Every CJK query in the C1 auto run still went through the translation path (Phase 2b-1's translation infra is still active and the `translate=auto` default routes through it). Translate latencies stayed in line with Phase 2b-1's ~205 ms p50.

**The translation no longer adds value at the eval level** — every query that translation would help is already a HIT under `translate=off` because bge-m3 handles the CN↔EN gap natively.

This is C1's intended outcome.

---

## Decision: Flip `SearchRequest.translate` default to `"off"`

Acceptance criterion §8-6 from the spec (≥9/10 with translate=off) is met. Per spec §3 row "Translation layer disable timing", the default flip is now justified.

What this means operationally:
- New `/search` requests without `translate` field → no LLM translation step → faster (~200ms less per CJK query) and one less LM Studio dependency
- Clients that want translation can still explicitly pass `"translate":"auto"`
- The Phase 2b-1 translation layer code stays in the tree as a rollback safety net (in case of future corpus changes that revive the CN/EN gap) — but it's no longer load-bearing
- B1 DingTalk tool description string updated to remove "CN is auto-translated" — bge-m3 handles it natively now

T7 (config + B1 description update) happens next, then T8 tags.

---

## What This Means for Phase 2b-1

Phase 2b-1's translation layer was a **patch** that delivered the right outcome (7→9/10) but treated the symptom. C1 fixes the underlying mechanism: the CN query and EN chunk now share a vector space.

**Phase 2b-1 doesn't get removed by C1 GA** — it stays in the tree, opt-in via `translate=auto`. But:
- Default user experience changes (passes through faster)
- The "translation prompt" test infrastructure (Phase 2b-1's `test_query_translator_prompt.py` with the 10 canon queries) still runs in CI/integration to guard against future regressions
- A future cleanup spec can remove translation entirely if no callers want it; out of scope here

---

## Caveats / Known Limitations

1. **Q9 is unfalsifiable from the current corpus.** Until we ingest a sample that contains real "package not delivered" complaints, we can't tell if Q9 would flip HIT with broader data. Recommendation: include "Lost in transit" / "MARKED_AS_DELIVERED_NOT_RECEIVED" reason codes in a future ingest pass (separate spec).

2. **Sample size differs slightly between Phase 2a/2b-1 (380 docs) and C1 (407 docs).** The 27 extra docs (~7%) might marginally affect retrieval. But Phase 2b-1 already showed 9/10 with the smaller sample, so the bge-m3 result isn't a sample-size artifact.

3. **`references[]` still empty** in C1 results — the same A1 limitation persists because ingest still doesn't set `file_path` on chunks. Orthogonal to C1; fixes in B2 territory.

4. **Other languages not validated.** Real refund_comments include Spanish, Italian, German (EP-EU markets). bge-m3 supports 100+ languages but we haven't tested these. They'd light up automatically with `translate=off`; sampling can confirm in a B2 multi-account ingest.

---

## Conclusion

**C1 GA-ready.** Tag `rag-c1-multilingual-embedding-ga` recommended. Translate default flips to `off`. Phase 2b-1 translation layer becomes opt-in.
