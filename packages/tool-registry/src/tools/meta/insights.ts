import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryMeta } from "./client.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const breakdownSchema = z.enum([
  "age",
  "gender",
  "country",
  "region",
  "publisher_platform",
  "platform_position",
  "impression_device",
]);

const inputSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^(act_)?\d+$/, "accountId must be numeric (with or without 'act_' prefix)")
      .min(1)
      .max(64),
    since: z.string().regex(ISO_DATE, "since must be YYYY-MM-DD"),
    until: z.string().regex(ISO_DATE, "until must be YYYY-MM-DD"),
    level: z.enum(["account", "campaign", "adset", "ad"]).default("account"),
    breakdowns: z.array(breakdownSchema).optional(),
    timeIncrement: z.enum(["all_days", "1"]).default("all_days"),
  })
  .strict()
  .refine((v) => v.since <= v.until, { message: "since must be <= until" });

const outputSchema = z.object({
  rows: z.array(z.unknown()),
});

export type MetaInsightsInput = z.infer<typeof inputSchema>;
export type MetaInsightsOutput = z.infer<typeof outputSchema>;

async function handleInsights(ctx: ExecutionContext, input: MetaInsightsInput): Promise<MetaInsightsOutput> {
  const result = await queryMeta(ctx.companyId, { op: "insights", ...input });
  return outputSchema.parse(result);
}

export const insightsDescriptor: ToolDescriptor<MetaInsightsInput, MetaInsightsOutput> = {
  id: "meta.insights",
  cliSubcommand: "insights",
  source: "meta",
  description:
    "Fetch Meta insights at account, campaign, adset, or ad level with optional breakdowns and daily rows (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["accessToken"],
  handler: handleInsights,
};
