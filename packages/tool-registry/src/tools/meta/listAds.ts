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
    campaignId: z.string().min(1).max(128).optional(),
    effectiveStatus: z.array(z.string()).optional(),
  })
  .strict();

const outputSchema = z.object({
  ads: z.array(z.unknown()),
});

export type MetaListAdsInput = z.infer<typeof inputSchema>;
export type MetaListAdsOutput = z.infer<typeof outputSchema>;

async function handleListAds(ctx: ExecutionContext, input: MetaListAdsInput): Promise<MetaListAdsOutput> {
  const result = await queryMeta(ctx.companyId, { op: "listAds", ...input });
  return outputSchema.parse(result);
}

export const listAdsDescriptor: ToolDescriptor<MetaListAdsInput, MetaListAdsOutput> = {
  id: "meta.listAds",
  cliSubcommand: "list-ads",
  source: "meta",
  description: "List Meta ads for an ad account or campaign, including creative metadata (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["accessToken"],
  handler: handleListAds,
};
