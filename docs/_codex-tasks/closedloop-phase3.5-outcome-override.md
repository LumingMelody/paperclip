You are Codex implementing **Phase 3.5** of the closed-loop suggestion
tracking system — a tiny fix discovered during Phase 3 smoke testing.

## The bug

When the ClosedLoopChecker agent encounters an extraction failure
(JMESPath path returns null / wrong type), per its AGENTS.md it calls
`POST /api/suggestions/:id/measure` with `actualValue=0`. But the server's
`measure` logic then computes `outcomeLabel` from raw delta — for a
direction='increase' baseline=100 actual=0 it returns `outcomeLabel='worsened'`
when the truth is "inconclusive". The agent has no way to override.

## The fix

Add an optional `outcomeOverride` field to `measureSuggestionSchema` that,
when provided, bypasses the auto-computation in the service layer and uses
the override value verbatim.

## Shell rules

**Allowed**: `cat`, `ls`, `rg`, `sed -n`.
**Forbidden**: `git`, `pnpm db:*`, full-repo `tsc`, `docker`, network. Claude commits and runs migrations / restarts.
You MAY run `pnpm --filter @paperclipai/shared exec tsc --noEmit` and `pnpm --filter @paperclipai/server exec tsc --noEmit`.

## What to do

### Change 1 (modify): `packages/shared/src/validators/suggestion.ts`

Find the existing `measureSuggestionSchema` definition (currently has
`actualValue` and `actualDate` only). Extend it to add `outcomeOverride`:

```typescript
export const measureSuggestionSchema = z.object({
  actualValue: z.number().finite(),
  actualDate: z.string().datetime().optional(),
  outcomeOverride: z.enum(SUGGESTION_OUTCOMES).optional(),
}).strict();
```

Do not change anything else in the file.

### Change 2 (modify): `server/src/services/suggestions.ts`

Find the `measure` method. Currently it computes `outcomeLabel` purely
from the direction + deltaPercent. Update it so that when
`input.outcomeOverride` is provided, the override is used as the
`outcomeLabel` (the computed delta values still get persisted; only the
label is overridden).

Replace the existing body of the `measure` method with this version:

```typescript
    async measure(id: string, input: MeasureSuggestionInput) {
      const current = await this.getById(id);
      if (!current) return null;
      const baseline = current.baselineValue;
      const actual = input.actualValue;
      const deltaAbsolute = actual - baseline;
      const deltaPercent = baseline === 0 ? null : (deltaAbsolute / baseline) * 100;
      let outcomeLabel: "improved" | "unchanged" | "worsened" | "inconclusive" = "inconclusive";
      if (input.outcomeOverride) {
        outcomeLabel = input.outcomeOverride;
      } else if (deltaPercent !== null) {
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
```

Do not change other methods.

---

## Rules

- Copy verbatim.
- Don't touch any file not listed above.
- Stop and report on contradiction.

## Report

1. `grep -n "outcomeOverride" packages/shared/src/validators/suggestion.ts server/src/services/suggestions.ts`
2. `pnpm --filter @paperclipai/shared exec tsc --noEmit`
3. `pnpm --filter @paperclipai/server exec tsc --noEmit`
4. Deviations (should be none).
