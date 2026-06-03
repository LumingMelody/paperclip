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
  warehouseName: z.string(),
  salesQty: z.number(),
  returnQty: z.number(),
  returnRate: z.number().nullable(),
  returnShare: z.number(),
});

const outputSchema = cohortMetadataSchema.extend({
  rows: z.array(rowSchema),
  dirtyWarehousePct: z.number(),
});

export type DwsSiteReturnRateByWarehouseInput = z.infer<typeof inputSchema>;
export type DwsSiteReturnRateByWarehouseOutput = z.infer<typeof outputSchema>;

async function handler(
  ctx: ExecutionContext,
  input: DwsSiteReturnRateByWarehouseInput,
): Promise<DwsSiteReturnRateByWarehouseOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "siteReturnRateByWarehouse",
    account: siteToAccount(input.site),
    since: input.since,
    until: input.until,
    maturityDays: input.maturityDays ?? 45,
  });
  return outputSchema.parse(result);
}

export const siteReturnRateByWarehouseDescriptor: ToolDescriptor<
  DwsSiteReturnRateByWarehouseInput,
  DwsSiteReturnRateByWarehouseOutput
> = {
  id: "dws.siteReturnRateByWarehouse",
  cliSubcommand: "site-return-rate-by-warehouse",
  source: "dws",
  description:
    "Independent-site Shopify current observed return rate by raw warehouseName. Empty warehouseName and " +
    "'无仓库记录' are kept as their own no-warehouse bucket; warehouse values are not mapped to CN/万州/US/谷仓/天码. " +
    "returnShare is each warehouse returnQty divided by the full-site current-window returnQty, and " +
    "dirtyWarehousePct is the no-warehouse row share." +
    siteReturnDescriptionSuffix,
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: DWS_REQUIRED_SECRETS,
  handler,
};
