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

const inputSchema = z.object(siteCohortBaseInputSchema).strict();

const rowSchema = z.object({
  unitsBucket: z.enum(["1", "2", "3", "4", "5+"]),
  orderCount: z.number(),
  salesQty: z.number(),
  returnQty: z.number(),
  returnRate: z.number().nullable(),
});

const outputSchema = cohortMetadataSchema.extend({
  rows: z.array(rowSchema),
});

export type DwsSiteReturnRateByOrderUnitsInput = z.infer<typeof inputSchema>;
export type DwsSiteReturnRateByOrderUnitsOutput = z.infer<typeof outputSchema>;

async function handler(
  ctx: ExecutionContext,
  input: DwsSiteReturnRateByOrderUnitsInput,
): Promise<DwsSiteReturnRateByOrderUnitsOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "siteReturnRateByOrderUnits",
    account: siteToAccount(input.site),
    since: input.since,
    until: input.until,
    maturityDays: input.maturityDays ?? 45,
  });
  return outputSchema.parse(result);
}

export const siteReturnRateByOrderUnitsDescriptor: ToolDescriptor<
  DwsSiteReturnRateByOrderUnitsInput,
  DwsSiteReturnRateByOrderUnitsOutput
> = {
  id: "dws.siteReturnRateByOrderUnits",
  cliSubcommand: "site-return-rate-by-order-units",
  source: "dws",
  description:
    "Independent-site Shopify current observed return rate by order-size bucket. The tool first aggregates " +
    "orderid to total sold units SUM(quantity), buckets orders into 1/2/3/4/5+ where >=5 is 5+, and then " +
    "computes returnRate as bucket SUM(COALESCE(return_quantity,0))/SUM(quantity)." +
    siteReturnDescriptionSuffix,
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: DWS_REQUIRED_SECRETS,
  handler,
};
