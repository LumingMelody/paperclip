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
