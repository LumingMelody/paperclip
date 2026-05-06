import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryMeta } from "./client.js";

const inputSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^(act_)?\d+$/, "accountId must be numeric (with or without 'act_' prefix)")
      .min(1)
      .max(64),
  })
  .strict();

const outputSchema = z.object({
  account: z.custom((value) => value !== undefined, "account is required"),
});

export type MetaAdAccountSummaryInput = z.infer<typeof inputSchema>;
export type MetaAdAccountSummaryOutput = z.infer<typeof outputSchema>;

async function handleAdAccountSummary(
  ctx: ExecutionContext,
  input: MetaAdAccountSummaryInput,
): Promise<MetaAdAccountSummaryOutput> {
  const result = await queryMeta(ctx.companyId, { op: "adAccountSummary", ...input });
  return outputSchema.parse(result);
}

export const adAccountSummaryDescriptor: ToolDescriptor<MetaAdAccountSummaryInput, MetaAdAccountSummaryOutput> = {
  id: "meta.adAccountSummary",
  cliSubcommand: "ad-account-summary",
  source: "meta",
  description: "Fetch a Meta ad account summary (name, currency, status, balance) (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["accessToken"],
  handler: handleAdAccountSummary,
};
