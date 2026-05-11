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

New `suggestions` table in paperclip's main Postgres DB (Drizzle pg, sibling to `routines` / `issues`).

```typescript
// packages/db/src/schema/suggestions.ts (final Drizzle schema)
export const suggestions = pgTable("suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  sourceAgentId: uuid("source_agent_id").notNull().references(() => agents.id),
  sequenceLabel: text("sequence_label").notNull(),            // 'S1' / 'S2' / 'S3'
  text: text("text").notNull(),
  metricToolId: text("metric_tool_id").notNull(),             // 'dws.returnReasons'
  metricArgs: jsonb("metric_args").$type<Record<string,unknown>>().notNull(),
  metricExtract: text("metric_extract").notNull(),            // JMESPath
  direction: text("direction").notNull(),                     // 'decrease' | 'increase'
  baselineValue: doublePrecision("baseline_value").notNull(),
  baselineDate: text("baseline_date").notNull(),              // ISO date
  followUpDays: integer("follow_up_days").notNull().default(28),
  status: text("status").notNull().default("proposed"),       // proposed|accepted|rejected|measured|dismissed
  adoptedAt: timestamp("adopted_at", { withTimezone: true }),
  actualValue: doublePrecision("actual_value"),
  actualDate: timestamp("actual_date", { withTimezone: true }),
  deltaAbsolute: doublePrecision("delta_absolute"),
  deltaPercent: doublePrecision("delta_percent"),
  outcomeLabel: text("outcome_label"),                        // improved|unchanged|worsened|inconclusive
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyStatusIdx: index("suggestions_company_status_idx").on(t.companyId, t.status),
  issueIdx: index("suggestions_issue_idx").on(t.sourceIssueId),
  followUpIdx: index("suggestions_followup_idx").on(t.status, t.adoptedAt),
  uniqIssueLabel: uniqueIndex("suggestions_issue_label_uniq").on(t.sourceIssueId, t.sequenceLabel),
}));
```

Status / direction / outcome enums enforced in the zod validator (not via Postgres `CHECK` — matches existing routines pattern).

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

✅ **Phase 3 done 2026-05-11** (commit pending). End-to-end demo:
- Created agent **ClosedLoopChecker** (id `b6f18516-d618-4987-82c5-7cb5f2521e23`, icon=eye) with full AGENTS.md prompt
- Daily routine (cron `15 9 * * *` Asia/Shanghai, id `d8daf6f8-7239-488a-bca3-178216d20706`) creates a run-issue assigned to CLC each day
- Smoke test: backfilled suggestion `ae54d6b1` (adoptedAt 5d ago, followUpDays=1) → CLC woke up → hit `/suggestions/due` → got the row → ran `lingxing.topSkus` → attempted JMESPath extract → posted measure + comments on both source issue (CRO-46) and run issue (CRO-49) → marked CRO-49 `done`
- **Bug surfaced**: when extraction fails, agent correctly sets `actualValue=0` per AGENTS.md but server's `measure` logic computes outcome from raw delta (gets 'worsened' instead of 'inconclusive'). Phase 3.5 fix: add `outcomeOverride` field to `measureSuggestionSchema` so the agent can pass `inconclusive` explicitly when extraction fails.

**End of Phase 4 (V1 GA)**: Anna can on phone:
1. See a Marketing 周报 in DingTalk (auto-pushed when routine fires)
2. Reply "采纳 S1 S3"
3. 4 weeks later, get a DingTalk message: "S1 (改 EE41981 尺码表): 38 → 22 单 (-42%) ✅"

This loop = ONE complete cycle observable end-to-end.

✅ **Phase 4 done 2026-05-11** (mostly):
- `scripts/paperclip-dingtalk-push.sh` — signed HMAC POST to DingTalk group webhook
- 5 routine AGENTS.md (Marketing/Supply/ProductSizing/Finance/CXOps) updated with "推送到钉钉" section
- Bot `intents.parse_accept()` + `suggestions_client.py` + `main.py` accept-fast-path: "采纳 S1 S3" / "拒绝 S2" → PATCH /api/suggestions/{id}
- End-to-end simulation passed: `parse_accept('采纳 S9')` → `find_by_labels` → `patch_status('accepted')` → DB row status='proposed' → 'accepted', adoptedAt auto-set

**Manual setup still needed before fully live**:
- Create DingTalk custom group robot, paste webhook URL + HMAC secret into the paperclip-dev launchd plist env (DINGTALK_WEBHOOK_URL / DINGTALK_WEBHOOK_SECRET)
- Make sure routine agents can read those env vars (they should — launchd injects them)
- (Optional v2) Switch from group webhook to active DM via bot AccessToken refresh + reply_specified_single_chat for true 1:1 push

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
4. **Storage**: PostgreSQL in paperclip server's main DB (Drizzle pg, same DB as routines/issues) via Drizzle (not separate package)
5. **JMESPath** for extract (vs custom DSL): mature lib, agent prompt-friendly
6. **One closed-loop agent**: new dedicated `ClosedLoopChecker` agent (not CXOps overload) for telemetry clarity
7. **Default `followUpDays`**: 28 (4 weeks — covers Amazon refund window + listing rotation)
8. **Push delivery**: existing DingTalk bot adds reverse channel — not a separate Slack/Lark layer
