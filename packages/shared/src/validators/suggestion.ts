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
