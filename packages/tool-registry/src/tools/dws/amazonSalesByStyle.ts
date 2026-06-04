import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(DATE_RE, "since must be YYYY-MM-DD"),
    until: z
      .string()
      .regex(DATE_RE, "until must be YYYY-MM-DD")
      .describe(
        "Exclusive upper bound date (YYYY-MM-DD): matches statistic_time_local >= since AND statistic_time_local < until. " +
          "For a full calendar month use the first of the NEXT month, e.g. all of April 2026 = until 2026-05-01. " +
          "Output coveredThrough echoes the inclusive last day (2026-04-30).",
      )
      .optional(),
    top: z.coerce.number().int().min(1).max(100).optional(),
    style: z.string().optional(),
  })
  .strict();

const rowSchema = z.object({
  styleCode: z.string().nullable(),
  salesQty: z.number(),
  orderCount: z.number(),
  skuCount: z.number(),
  firstSaleDate: z.string().nullable(),
  lastSaleDate: z.string().nullable(),
});

const outputSchema = z.object({
  rows: z.array(rowSchema),
  asOfDate: z.string(),
  windowStart: z.string(),
  windowEnd: z.string().nullable(),
  coveredThrough: z.string().nullable(),
});

export type DwsAmazonSalesByStyleInput = z.infer<typeof inputSchema>;
export type DwsAmazonSalesByStyleOutput = z.infer<typeof outputSchema>;

type AmazonSalesByStyleRequest = Extract<Parameters<typeof queryDws>[1], { op: "amazonSalesByStyle" }> & {
  until?: string;
};

async function handler(ctx: ExecutionContext, input: DwsAmazonSalesByStyleInput): Promise<DwsAmazonSalesByStyleOutput> {
  const request: AmazonSalesByStyleRequest = {
    op: "amazonSalesByStyle",
    account: shopToAccount(input.shop),
    since: input.since,
    until: input.until,
    top: input.top ?? 20,
    style: input.style,
  };
  const result = await queryDws(ctx.companyId, request);
  return outputSchema.parse(result);
}

export const amazonSalesByStyleDescriptor: ToolDescriptor<DwsAmazonSalesByStyleInput, DwsAmazonSalesByStyleOutput> = {
  id: "dws.amazonSalesByStyle",
  cliSubcommand: "amazon-sales-by-style",
  source: "dws",
  description:
    "Amazon T+0 fresh style-code sales units from dws_od_amazon_order_d, grouped by " +
    "LEFT(processed_sku, 7). Covers the 8 AmazonEP marketplaces plus matching PZ/DAMA " +
    "shop accounts exposed by DWS. Excludes YS% original_sku rows, blank original/processed " +
    "SKUs, and gift-card rows via is_allcard IN (0,1). Returns unit sales only: no GMV; use " +
    "Lingxing tools for GMV, ASIN details, ratings, reviews, or ads. Fresh sales means there " +
    "are recent Amazon orders; it does not prove the listing is currently online. Omit style " +
    "to rank top styles by salesQty; pass an exact style code to query one style without ranking.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
