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
    effectiveStatus: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(5000).optional(),
  })
  .strict();

const outputSchema = z.object({
  campaigns: z.array(z.unknown()),
});

export type MetaListCampaignsInput = z.infer<typeof inputSchema>;
export type MetaListCampaignsOutput = z.infer<typeof outputSchema>;

async function handleListCampaigns(
  ctx: ExecutionContext,
  input: MetaListCampaignsInput,
): Promise<MetaListCampaignsOutput> {
  const result = await queryMeta(ctx.companyId, { op: "listCampaigns", ...input });
  return outputSchema.parse(result);
}

export const listCampaignsDescriptor: ToolDescriptor<MetaListCampaignsInput, MetaListCampaignsOutput> = {
  id: "meta.listCampaigns",
  cliSubcommand: "list-campaigns",
  source: "meta",
  description: "List Meta campaigns for an ad account with optional effective_status filtering (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["accessToken"],
  handler: handleListCampaigns,
};
