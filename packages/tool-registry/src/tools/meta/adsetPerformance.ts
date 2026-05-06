import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryMeta } from "./client.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^(act_)?\d+$/, "accountId must be numeric (with or without 'act_' prefix)")
      .min(1)
      .max(64),
    since: z.string().regex(ISO_DATE, "since must be YYYY-MM-DD"),
    until: z.string().regex(ISO_DATE, "until must be YYYY-MM-DD"),
  })
  .strict()
  .refine((v) => v.since <= v.until, { message: "since must be <= until" });

const outputSchema = z.object({
  rows: z.array(z.unknown()),
});

export type MetaAdsetPerformanceInput = z.infer<typeof inputSchema>;
export type MetaAdsetPerformanceOutput = z.infer<typeof outputSchema>;

async function handleAdsetPerformance(
  ctx: ExecutionContext,
  input: MetaAdsetPerformanceInput,
): Promise<MetaAdsetPerformanceOutput> {
  const result = await queryMeta(ctx.companyId, { op: "adsetPerformance", ...input });
  return outputSchema.parse(result);
}

export const adsetPerformanceDescriptor: ToolDescriptor<MetaAdsetPerformanceInput, MetaAdsetPerformanceOutput> = {
  id: "meta.adsetPerformance",
  cliSubcommand: "adset-performance",
  source: "meta",
  description:
    "Fetch Meta adset-level insights (spend, impressions, ROAS, actions) for a date range (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["accessToken"],
  handler: handleAdsetPerformance,
};
