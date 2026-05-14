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
