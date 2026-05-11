You are Codex implementing **Phase 1 of the closed-loop suggestion tracking
system** (G in the Ever-Pretty AI roadmap). Spec lives at
`docs/superpowers/specs/2026-05-11-closed-loop-suggestions-design.md`;
this task implements only the storage + API layer, not the agent prompts,
not the DingTalk push, not the closed-loop checker routine.

## Pattern reference (don't change these, use as templates)

- Schema: see `packages/db/src/schema/goals.ts` (simple pgTable + index)
  and `packages/db/src/schema/routines.ts` (more fields with defaults).
- Schema index: append to `packages/db/src/schema/index.ts`.
- Validator: see `packages/shared/src/validators/routine.ts`.
- Validator index: append to `packages/shared/src/validators/index.ts`.
- Shared index: re-exports from `packages/shared/src/index.ts`.
- Service: see `server/src/services/goals.ts`.
- Service index: append to `server/src/services/index.ts`.
- Route: see `server/src/routes/goals.ts`.
- App wiring: see `server/src/app.ts` around line 201 (`api.use(routineRoutes(db, …))`).

## Shell rules

**Allowed**: `cat`, `ls`, `rg`, `sed -n`.
**Forbidden**: `uv`, `pip`, `pnpm install`, `pnpm db:generate`, `pnpm db:migrate`, `git`, `docker`, network. Claude handles migration + repo-wide install + commit.
You MAY run `pnpm --filter @paperclipai/db exec tsc --noEmit`, `pnpm --filter @paperclipai/shared exec tsc --noEmit`, `pnpm --filter @paperclipai/server exec tsc --noEmit` for scoped self-check.

## What to do

### File 1 (create): `packages/db/src/schema/suggestions.ts`

```typescript
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const suggestions = pgTable(
  "suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    sourceAgentId: uuid("source_agent_id")
      .notNull()
      .references(() => agents.id),
    sequenceLabel: text("sequence_label").notNull(),
    text: text("text").notNull(),
    metricToolId: text("metric_tool_id").notNull(),
    metricArgs: jsonb("metric_args").$type<Record<string, unknown>>().notNull(),
    metricExtract: text("metric_extract").notNull(),
    direction: text("direction").notNull(),
    baselineValue: doublePrecision("baseline_value").notNull(),
    baselineDate: text("baseline_date").notNull(),
    followUpDays: integer("follow_up_days").notNull().default(28),
    status: text("status").notNull().default("proposed"),
    adoptedAt: timestamp("adopted_at", { withTimezone: true }),
    actualValue: doublePrecision("actual_value"),
    actualDate: timestamp("actual_date", { withTimezone: true }),
    deltaAbsolute: doublePrecision("delta_absolute"),
    deltaPercent: doublePrecision("delta_percent"),
    outcomeLabel: text("outcome_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("suggestions_company_status_idx").on(table.companyId, table.status),
    issueIdx: index("suggestions_issue_idx").on(table.sourceIssueId),
    followUpIdx: index("suggestions_followup_idx").on(table.status, table.adoptedAt),
    uniqIssueLabel: uniqueIndex("suggestions_issue_label_uniq").on(
      table.sourceIssueId,
      table.sequenceLabel,
    ),
  }),
);
```

### File 2 (modify): `packages/db/src/schema/index.ts`

Append this one line at the end (file ends with similar `export { X } from "./y.js";` lines — keep that style):

```typescript
export { suggestions } from "./suggestions.js";
```

### File 3 (create): `packages/shared/src/validators/suggestion.ts`

```typescript
import { z } from "zod";

export const SUGGESTION_STATUSES = ["proposed", "accepted", "rejected", "measured", "dismissed"] as const;
export const SUGGESTION_DIRECTIONS = ["decrease", "increase"] as const;
export const SUGGESTION_OUTCOMES = ["improved", "unchanged", "worsened", "inconclusive"] as const;

export const metricSpecSchema = z.object({
  toolId: z.string().min(1).max(120),
  args: z.record(z.unknown()),
  extract: z.string().min(1).max(500),
  direction: z.enum(SUGGESTION_DIRECTIONS),
}).strict();

export const createSuggestionSchema = z.object({
  sourceIssueId: z.string().uuid(),
  sourceAgentId: z.string().uuid(),
  sequenceLabel: z.string().trim().regex(/^S\d{1,3}$/, "sequenceLabel must look like S1 / S2 / S12"),
  text: z.string().trim().min(1).max(2000),
  metric: metricSpecSchema,
  baselineValue: z.number().finite(),
  baselineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "baselineDate must be YYYY-MM-DD"),
  followUpDays: z.number().int().min(1).max(365).optional().default(28),
}).strict();

export const updateSuggestionSchema = z.object({
  status: z.enum(SUGGESTION_STATUSES).optional(),
  text: z.string().trim().min(1).max(2000).optional(),
  followUpDays: z.number().int().min(1).max(365).optional(),
}).strict().refine(
  (v) => Object.keys(v).length > 0,
  { message: "At least one field is required" },
);

export const measureSuggestionSchema = z.object({
  actualValue: z.number().finite(),
  actualDate: z.string().datetime().optional(),
}).strict();

export const listSuggestionsQuerySchema = z.object({
  status: z.union([z.enum(SUGGESTION_STATUSES), z.array(z.enum(SUGGESTION_STATUSES))]).optional(),
  sourceIssueId: z.string().uuid().optional(),
  sourceAgentId: z.string().uuid().optional(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
}).strict();

export type CreateSuggestionInput = z.infer<typeof createSuggestionSchema>;
export type UpdateSuggestionInput = z.infer<typeof updateSuggestionSchema>;
export type MeasureSuggestionInput = z.infer<typeof measureSuggestionSchema>;
export type ListSuggestionsQuery = z.infer<typeof listSuggestionsQuerySchema>;
```

### File 4 (modify): `packages/shared/src/validators/index.ts`

Append at the end (file ends with similar `export * from "./x.js";` lines):

```typescript
export * from "./suggestion.js";
```

### File 5 (modify): `packages/shared/src/index.ts`

Find the existing block of validator re-exports (search for `createRoutineSchema`).
Add `createSuggestionSchema`, `updateSuggestionSchema`, `measureSuggestionSchema`,
`listSuggestionsQuerySchema`, `metricSpecSchema`, `SUGGESTION_STATUSES`,
`SUGGESTION_DIRECTIONS`, `SUGGESTION_OUTCOMES` plus the four type aliases
(`CreateSuggestionInput`, `UpdateSuggestionInput`, `MeasureSuggestionInput`,
`ListSuggestionsQuery`) to the same kind of named-re-export block. Use the
same import path as routine.

If the block looks like:

```typescript
export {
  createRoutineSchema,
  updateRoutineSchema,
  ...
} from "./validators/routine.js";
```

Add another block right below:

```typescript
export {
  createSuggestionSchema,
  updateSuggestionSchema,
  measureSuggestionSchema,
  listSuggestionsQuerySchema,
  metricSpecSchema,
  SUGGESTION_STATUSES,
  SUGGESTION_DIRECTIONS,
  SUGGESTION_OUTCOMES,
} from "./validators/suggestion.js";
export type {
  CreateSuggestionInput,
  UpdateSuggestionInput,
  MeasureSuggestionInput,
  ListSuggestionsQuery,
} from "./validators/suggestion.js";
```

If the existing pattern is `export *` instead, mirror that. Don't change anything else.

### File 6 (create): `server/src/services/suggestions.ts`

```typescript
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { suggestions } from "@paperclipai/db";
import type {
  CreateSuggestionInput,
  ListSuggestionsQuery,
  MeasureSuggestionInput,
  UpdateSuggestionInput,
} from "@paperclipai/shared";

export function suggestionService(db: Db) {
  return {
    async list(companyId: string, q: ListSuggestionsQuery) {
      const conds = [eq(suggestions.companyId, companyId)];
      if (q.status) {
        const statuses = Array.isArray(q.status) ? q.status : [q.status];
        conds.push(inArray(suggestions.status, statuses));
      }
      if (q.sourceIssueId) conds.push(eq(suggestions.sourceIssueId, q.sourceIssueId));
      if (q.sourceAgentId) conds.push(eq(suggestions.sourceAgentId, q.sourceAgentId));
      if (q.since) conds.push(gte(suggestions.createdAt, new Date(`${q.since}T00:00:00Z`)));
      return db
        .select()
        .from(suggestions)
        .where(and(...conds))
        .orderBy(desc(suggestions.createdAt))
        .limit(q.limit ?? 100);
    },

    async getById(id: string) {
      const rows = await db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async create(companyId: string, input: CreateSuggestionInput) {
      const [row] = await db
        .insert(suggestions)
        .values({
          companyId,
          sourceIssueId: input.sourceIssueId,
          sourceAgentId: input.sourceAgentId,
          sequenceLabel: input.sequenceLabel,
          text: input.text,
          metricToolId: input.metric.toolId,
          metricArgs: input.metric.args,
          metricExtract: input.metric.extract,
          direction: input.metric.direction,
          baselineValue: input.baselineValue,
          baselineDate: input.baselineDate,
          followUpDays: input.followUpDays ?? 28,
        })
        .returning();
      return row;
    },

    async update(id: string, input: UpdateSuggestionInput) {
      const patch: Record<string, unknown> = {
        ...input,
        updatedAt: new Date(),
      };
      if (input.status === "accepted") {
        patch.adoptedAt = new Date();
      }
      const [row] = await db
        .update(suggestions)
        .set(patch)
        .where(eq(suggestions.id, id))
        .returning();
      return row ?? null;
    },

    async measure(id: string, input: MeasureSuggestionInput) {
      const current = await this.getById(id);
      if (!current) return null;
      const baseline = current.baselineValue;
      const actual = input.actualValue;
      const deltaAbsolute = actual - baseline;
      const deltaPercent = baseline === 0 ? null : (deltaAbsolute / baseline) * 100;
      let outcomeLabel: "improved" | "unchanged" | "worsened" | "inconclusive" = "inconclusive";
      if (deltaPercent !== null) {
        const absPct = Math.abs(deltaPercent);
        if (absPct < 10) {
          outcomeLabel = "unchanged";
        } else if (current.direction === "decrease") {
          outcomeLabel = deltaPercent < 0 ? "improved" : "worsened";
        } else {
          outcomeLabel = deltaPercent > 0 ? "improved" : "worsened";
        }
      }
      const [row] = await db
        .update(suggestions)
        .set({
          actualValue: actual,
          actualDate: input.actualDate ? new Date(input.actualDate) : new Date(),
          deltaAbsolute,
          deltaPercent,
          outcomeLabel,
          status: "measured",
          updatedAt: new Date(),
        })
        .where(eq(suggestions.id, id))
        .returning();
      return row ?? null;
    },

    async listDue(companyId: string) {
      // Accepted suggestions whose follow-up window has elapsed and not yet measured.
      // SQL: adopted_at + (follow_up_days || ' days')::interval <= NOW()
      return db
        .select()
        .from(suggestions)
        .where(
          and(
            eq(suggestions.companyId, companyId),
            eq(suggestions.status, "accepted"),
            sql`${suggestions.adoptedAt} IS NOT NULL`,
            sql`${suggestions.adoptedAt} + (${suggestions.followUpDays} || ' days')::interval <= now()`,
          ),
        )
        .orderBy(desc(suggestions.adoptedAt));
    },
  };
}
```

### File 7 (modify): `server/src/services/index.ts`

Append at the bottom:

```typescript
export { suggestionService } from "./suggestions.js";
```

### File 8 (create): `server/src/routes/suggestions.ts`

```typescript
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSuggestionSchema,
  listSuggestionsQuerySchema,
  measureSuggestionSchema,
  updateSuggestionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, suggestionService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function suggestionRoutes(db: Db) {
  const router = Router();
  const svc = suggestionService(db);

  router.get("/companies/:companyId/suggestions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listSuggestionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }
    const rows = await svc.list(companyId, parsed.data);
    res.json({ rows });
  });

  router.get("/suggestions/:id", async (req, res) => {
    const row = await svc.getById(req.params.id as string);
    if (!row) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  router.post(
    "/companies/:companyId/suggestions",
    validate(createSuggestionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const row = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "suggestion.created",
        entityType: "suggestion",
        entityId: row.id,
        details: { sequenceLabel: row.sequenceLabel, sourceIssueId: row.sourceIssueId },
      });
      res.status(201).json(row);
    },
  );

  router.patch("/suggestions/:id", validate(updateSuggestionSchema), async (req, res) => {
    const id = req.params.id as string;
    const current = await svc.getById(id);
    if (!current) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    assertCompanyAccess(req, current.companyId);
    const row = await svc.update(id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: current.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "suggestion.updated",
      entityType: "suggestion",
      entityId: id,
      details: { changes: req.body },
    });
    res.json(row);
  });

  router.post(
    "/suggestions/:id/measure",
    validate(measureSuggestionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const current = await svc.getById(id);
      if (!current) {
        res.status(404).json({ error: "Suggestion not found" });
        return;
      }
      assertCompanyAccess(req, current.companyId);
      const row = await svc.measure(id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: current.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "suggestion.measured",
        entityType: "suggestion",
        entityId: id,
        details: { actualValue: req.body.actualValue, outcomeLabel: row?.outcomeLabel },
      });
      res.json(row);
    },
  );

  router.get("/companies/:companyId/suggestions/due", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.listDue(companyId);
    res.json({ rows });
  });

  return router;
}
```

### File 9 (modify): `server/src/app.ts`

Two edits:

(a) Add an import line in the imports section. Find the existing line:

```typescript
import { routineRoutes } from "./routes/routines.js";
```

Add directly below it:

```typescript
import { suggestionRoutes } from "./routes/suggestions.js";
```

(b) Find the route registration line:

```typescript
  api.use(routineRoutes(db, { pluginWorkerManager: workerManager }));
```

Add directly below it:

```typescript
  api.use(suggestionRoutes(db));
```

Do not change anything else in app.ts.

---

## Rules

- Copy verbatim — no extra comments / refactors / unrelated cleanup.
- Don't touch any file not listed above.
- Don't run `pnpm db:generate` (Claude will do this — needs working DB).
- Stop and report on contradiction.

## Report

1. `wc -l` for each new file
2. `grep -n "suggestion" packages/db/src/schema/index.ts packages/shared/src/index.ts packages/shared/src/validators/index.ts server/src/services/index.ts server/src/app.ts | head -30`
3. Scoped TS checks:
   - `pnpm --filter @paperclipai/db exec tsc --noEmit`
   - `pnpm --filter @paperclipai/shared exec tsc --noEmit`
   - `pnpm --filter @paperclipai/server exec tsc --noEmit`
4. Deviations (should be none).
