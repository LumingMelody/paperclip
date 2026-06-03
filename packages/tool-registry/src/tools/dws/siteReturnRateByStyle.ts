import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws } from "./client.js";
import {
  cohortMetadataSchema,
  DWS_REQUIRED_SECRETS,
  siteCohortBaseInputSchema,
  siteReturnDescriptionSuffix,
  siteToAccount,
} from "./siteReturnCommon.js";

const inputSchema = z
  .object({
    ...siteCohortBaseInputSchema,
    top: z.coerce.number().int().min(1).max(100).optional(),
    minQty: z.coerce.number().int().min(1).optional(),
    style: z.string().optional(),
  })
  .strict();

const rowSchema = z.object({
  styleCode: z.string().nullable(),
  salesQty: z.number(),
  returnQty: z.number(),
  returnRate: z.number().nullable(),
  skuCount: z.number(),
});

const outputSchema = cohortMetadataSchema.extend({
  rows: z.array(rowSchema),
});

export type DwsSiteReturnRateByStyleInput = z.infer<typeof inputSchema>;
export type DwsSiteReturnRateByStyleOutput = z.infer<typeof outputSchema>;

async function handler(
  ctx: ExecutionContext,
  input: DwsSiteReturnRateByStyleInput,
): Promise<DwsSiteReturnRateByStyleOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "siteReturnRateByStyle",
    account: siteToAccount(input.site),
    since: input.since,
    until: input.until,
    top: input.top ?? 20,
    minQty: input.minQty ?? 50,
    maturityDays: input.maturityDays ?? 45,
    style: input.style,
  });
  return outputSchema.parse(result);
}

export const siteReturnRateByStyleDescriptor: ToolDescriptor<
  DwsSiteReturnRateByStyleInput,
  DwsSiteReturnRateByStyleOutput
> = {
  id: "dws.siteReturnRateByStyle",
  cliSubcommand: "site-return-rate-by-style",
  source: "dws",
  description:
    "Independent-site Shopify per-style current observed return rate by pay_time cohort. " +
    "Omit style to return top-N styles ordered by currentReturnRate semantics (returnRate DESC) after " +
    "salesQty >= minQty; pass style for one exact LEFT(shipping_sku,7) style without ranking." +
    siteReturnDescriptionSuffix,
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: DWS_REQUIRED_SECRETS,
  handler,
};
