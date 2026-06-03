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
    style: z.string().optional(),
  })
  .strict();

const rowSchema = z.object({
  styleCode: z.string().nullable(),
  returnedQty: z.number(),
  qty_0_30: z.number(),
  qty_31_45: z.number(),
  qty_45plus: z.number(),
  pct_0_30: z.number().nullable(),
  pct_31_45: z.number().nullable(),
  pct_45plus: z.number().nullable(),
});

const outputSchema = cohortMetadataSchema.extend({
  rows: z.array(rowSchema),
});

export type DwsSiteReturnTimingByStyleInput = z.infer<typeof inputSchema>;
export type DwsSiteReturnTimingByStyleOutput = z.infer<typeof outputSchema>;

async function handler(
  ctx: ExecutionContext,
  input: DwsSiteReturnTimingByStyleInput,
): Promise<DwsSiteReturnTimingByStyleOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "siteReturnTimingByStyle",
    account: siteToAccount(input.site),
    since: input.since,
    until: input.until,
    top: input.top ?? 20,
    maturityDays: input.maturityDays ?? 45,
    style: input.style,
  });
  return outputSchema.parse(result);
}

export const siteReturnTimingByStyleDescriptor: ToolDescriptor<
  DwsSiteReturnTimingByStyleInput,
  DwsSiteReturnTimingByStyleOutput
> = {
  id: "dws.siteReturnTimingByStyle",
  cliSubcommand: "site-return-timing-by-style",
  source: "dws",
  description:
    "Independent-site Shopify per-style returned-unit timing distribution by pay_time cohort. Buckets are " +
    "DATEDIFF(return_time,pay_time) <= 30, 31-45, and 45+. This is the only Shopify return analysis tool " +
    "that filters to return_quantity > 0 with non-null return_time/pay_time, because its denominator is " +
    "already returnedQty rather than all sold units. Omit style for top-N styles by returnedQty; pass style " +
    "for one exact LEFT(shipping_sku,7) style." +
    siteReturnDescriptionSuffix,
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: DWS_REQUIRED_SECRETS,
  handler,
};
