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
      const patch: Partial<typeof suggestions.$inferInsert> = {
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

    async listDue(companyId: string) {
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
