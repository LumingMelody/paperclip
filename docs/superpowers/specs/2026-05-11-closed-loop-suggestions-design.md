# Closed-loop Suggestion Tracking — Design Spec

**Date**: 2026-05-11
**Author**: Claude (Opus 4.7) + 用户 (Anna 是终端用户，不是 author)
**Scope**: G — 闭环建议追踪 (重型方案：first-class suggestion entity)
**Goal**: Turn agents from "BI 助手"（answer questions）into "真 agent"（improve business）by tracking which agent suggestions Anna adopts and auto-measuring outcomes 4 weeks later.

---

## Why

Current state: agents put 建议 in 周报 evidence section, then it dies there. Nobody remembers which were adopted, nobody re-measures whether退货率 actually dropped. The "AI 改善业务" narrative has zero data backing it.

After this work: every weekly报告's suggestions get a unique label (S1/S2/S3) with a bound metric query. Anna sends 采纳 S1 S3 in DingTalk. 4 weeks later, the system auto-replays the query, compares before/after, posts the outcome back to Anna's phone + original issue.

End state demo line: *"上次你 5/11 采纳的 S1 (改 EE41981 尺码表): 偏小退货从 38 → 22 单 (-42%) ✅"*

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Routine (Marketing/Supply/ProductSizing/Finance/CXOps)      │
│ │ wakes up, runs analysis, builds 周报                       │
│ │ for each suggestion S1/S2/S3, calls suggestions.create     │
│ │ posts issue comment + writes plan document                 │
│ └─→ notify.dingtalkPush(issueId, anna_userid)               │
└──────────────────────────────────────────────┬──────────────┘
                                               │
                                               ▼
                              ┌────────────────────────────────┐
                              │ DingTalk bot (existing)         │
                              │ pushes issue summary to Anna    │
                              └────────────────────────────────┘
                                               │
                                               ▼
                              ┌────────────────────────────────┐
                              │ Anna replies "采纳 S1 S3"        │
                              │ bot.intents matches accept     │
                              │ PATCH /suggestions/{id}         │
                              │   status='accepted', adoptedAt  │
                              └────────────────────────────────┘
                                               │
                                               ▼ (28 days later)
┌─────────────────────────────────────────────────────────────┐
│ Closed-loop daily routine (ClosedLoopChecker agent)         │
│ │ SELECT suggestions WHERE status='accepted'                │
│ │   AND adoptedAt + followUpDays * day <= NOW               │
│ │   AND actualValue IS NULL                                 │
│ │ for each:                                                  │
│ │   - replay metricToolId(measureArgs) → newValue           │
│ │   - extract via JMESPath                                  │
│ │   - PATCH suggestion: actualValue, status='measured', delta│
│ │   - comment on original issue with outcome                │
│ │   - push to DingTalk                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Model

New SQLite table `suggestions` in paperclip server's main DB.

```sql
CREATE TABLE suggestions (
  id              TEXT PRIMARY KEY,        -- uuid v7
  company_id      TEXT NOT NULL,
  source_issue_id TEXT NOT NULL,           -- the 周报 issue
  source_agent_id TEXT NOT NULL,
  sequence_label  TEXT NOT NULL,           -- 'S1' / 'S2' / 'S3'
  text            TEXT NOT NULL,           -- '改 EE41981 尺码表加体重对照'
  metric_tool_id  TEXT NOT NULL,           -- 'dws.returnReasons'
  metric_args     TEXT NOT NULL,           -- JSON: {shop:"EP-US", sku:"EE41981"}
  metric_extract  TEXT NOT NULL,           -- JMESPath: 'rows[?returnReason==`too small`].returnCount | sum(@)'
  direction       TEXT NOT NULL CHECK (direction IN ('decrease','increase')),
  baseline_value  REAL NOT NULL,
  baseline_date   TEXT NOT NULL,           -- ISO date when baseline was captured
  follow_up_days  INTEGER NOT NULL DEFAULT 28,
  status          TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','accepted','rejected','measured','dismissed')),
  adopted_at      TEXT,                    -- ISO datetime when Anna marked 采纳
  actual_value    REAL,                    -- measured at follow_up
  actual_date     TEXT,                    -- when measured
  delta_absolute  REAL,                    -- actual_value - baseline_value
  delta_percent   REAL,                    -- (delta / baseline) * 100
  outcome_label   TEXT,                    -- 'improved' / 'unchanged' / 'worsened' / 'inconclusive'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (source_issue_id, sequence_label)
);
CREATE INDEX idx_suggestions_status_followup ON suggestions(status, adopted_at, follow_up_days);
CREATE INDEX idx_suggestions_issue ON suggestions(source_issue_id);
```

**State machine**:
```
proposed ──Anna 采纳──> accepted ──N days──> (measured | dismissed)
   │                       │
   └─Anna 拒绝──> rejected └─tool error/no-data──> dismissed
```

`outcome_label` 派生规则 (when status='measured'):
- `improved`: direction='decrease' AND actual < baseline * 0.9, OR direction='increase' AND actual > baseline * 1.1
- `worsened`: direction='decrease' AND actual > baseline * 1.1, OR direction='increase' AND actual < baseline * 0.9
- `unchanged`: |delta_percent| < 10%
- `inconclusive`: actual_value is null or baseline is 0

---

## Components Built

### Phase 1 — Storage + API (1.5 days)

1. **Drizzle schema** (server/src/db/schema/suggestions.ts) — table above
2. **Migration** generated via `pnpm db:generate`
3. **API routes** (server/src/api/suggestions.ts):
   - `POST /api/companies/:companyId/suggestions` — bulk create from routine
   - `GET /api/companies/:companyId/suggestions?status=...&since=...&issueId=...`
   - `GET /api/suggestions/:id`
   - `PATCH /api/suggestions/:id` — change status (proposed→accepted/rejected, with `adoptedAt` auto-set when status→accepted)
   - `POST /api/suggestions/:id/measure` — force remeasurement (admin)
4. **Tests**: cover state machine transitions, uniqueness constraint

### Phase 2 — `suggestions.create` tool + agent prompts (1 day)

1. **New tool** in tool-registry: `suggestions.create` — agents call this from inside a routine
2. **Update 5 routine agents' AGENTS.md** — append a "Suggestion contract" section: 周报 末尾必须 emit `S1/S2/S3` 标签 + 调用 `suggestions.create` 注册
3. **Tool test** that ensures structured form is enforced (zod schema)

### Phase 3 — Closed-loop checker routine (1.5 days)

1. **New agent** `ClosedLoopChecker` (or reuse CXOps — TBD, recommend new dedicated agent for telemetry clarity)
2. **Daily routine** at 09:15 CN: read overdue accepted suggestions, replay metricCall, JMESPath-extract value, update suggestion row, comment on original issue
3. **Tool**: `suggestions.measureDue` — new admin tool that does the heavy lifting (agent just calls this)
4. **JMESPath** dependency: `jmespath` npm package (~10 KB, mature)

### Phase 4 — DingTalk push + accept intent (1 day)

1. **Push channel**: new tool `notify.dingtalkPush(issueId, recipient)` — sends issue summary + suggestions list as DingTalk markdown card to Anna's userId
2. **Bot intent**: `intents.py` adds `ACCEPT` pattern (`采纳|拒绝 (S\d+(\s+S\d+)*)` and maps to `PATCH /api/suggestions/:id`. Context: bot remembers the last pushed issue per chat
3. **Demo end-to-end** with one real suggestion fired through the loop

---

## Out of Scope (Phase 2+)

- Web UI Suggestions panel (老板桌面端不是主用例)
- Multi-metric suggestions (e.g., "改尺码表 → 退货 AND GMV")
- Confidence intervals / statistical significance tests
- A/B-style holdout comparisons
- Auto-suggesting `metricSpec` from prose 建议 (let agents do this in their prompt instead)
- Roll-up dashboards ("Marketing agent 建议成功率 78%") — pull from DB ad-hoc

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Agents emit garbage `metricSpec` (wrong tool / bad JMESPath) | Phase 1 API validates `metric_tool_id` exists in registry; Phase 2 prompt examples; Phase 3 replay catches bad JMESPath and sets `outcome_label='inconclusive'` |
| `since` shift unsafe for some queries (cumulative metrics) | Convention: `measureArgs.since = adopted_at`, `until = adopted_at + followUpDays`. If query is cumulative (e.g., FBA inventory), agent should set `followUpDays` to ≥ a meaningful window AND use a snapshot tool not a delta tool |
| Anna marks 采纳 then changes mind | PATCH back to `proposed` allowed within 24h of `adopted_at`, server invariant rejects after |
| Closed-loop routine misfires when tool down | Wrap measure call in try/catch; on failure leave status='accepted', log, retry next day, escalate after 7 failed days |
| Anna ignores DingTalk push entirely | Suggestions stay `proposed` forever — no harm; weekly CXOps Anna brief routine includes a "pending suggestions" count, surfaces neglect |

---

## Success Criteria

**End of Phase 1**: can POST a suggestion, see it in GET, PATCH status, all via curl with audit fields populated.

**End of Phase 2**: at least one routine (pick ProductSizing) emits a structured suggestion. Issue contains S1/S2/S3 narrative AND `suggestions` rows reflect the same bindings.

**End of Phase 3**: backfill-fired suggestion (adoptedAt set to "now − 29 days") gets measured by next daily routine run. Outcome comment lands on original issue with delta numbers.

**End of Phase 4 (V1 GA)**: Anna can on phone:
1. See a Marketing 周报 in DingTalk (auto-pushed when routine fires)
2. Reply "采纳 S1 S3"
3. 4 weeks later, get a DingTalk message: "S1 (改 EE41981 尺码表): 38 → 22 单 (-42%) ✅"

This loop = ONE complete cycle observable end-to-end.

---

## Acceptance Demo (post-V1)

Single screen: open DingTalk → scroll to bot conversation → show:
- 上周一 Marketing 周报 with S1/S2/S3
- Anna's "采纳 S1 S3" reply
- Today's outcome message with改善%
- Open paperclip Web → original CRO-46 issue → comment thread shows the closed-loop outcome with same numbers

If both surfaces show the same delta, system is verified.

---

## Implementation Order (4 phases serial)

```
Phase 1 (Storage + API)      ████████████████░░░░░░░░░░░░░░░░ 1.5d
Phase 2 (Tool + prompts)     ░░░░░░░░░░░░░░░░██████████░░░░░░ 1.0d
Phase 3 (Closed-loop routine)░░░░░░░░░░░░░░░░░░░░░░░░██████████ 1.5d
Phase 4 (DingTalk push +
         accept intent)      ░░░░░░░░░░░░░░░░░░░░░░░░░░░░██████ 1.0d
                                                          total 5d
```

Each phase ends with a working slice. After Phase 1+2 alone, suggestions are registered and tracked even without auto-measurement.

Each phase = one Codex brief (Claude designs / Codex implements, per workflow rule).

---

## Decisions Made (no longer open)

1. **Depth**: heavy (first-class entity with table + API)
2. **Binding**: structured (`metricToolId + args + JMESPath extract + direction`)
3. **Adoption signal**: DingTalk command (`采纳 S1 S3`) — mobile-first; Web UI deferred
4. **Storage**: SQLite in paperclip server's main DB via Drizzle (not separate package)
5. **JMESPath** for extract (vs custom DSL): mature lib, agent prompt-friendly
6. **One closed-loop agent**: new dedicated `ClosedLoopChecker` agent (not CXOps overload) for telemetry clarity
7. **Default `followUpDays`**: 28 (4 weeks — covers Amazon refund window + listing rotation)
8. **Push delivery**: existing DingTalk bot adds reverse channel — not a separate Slack/Lark layer
