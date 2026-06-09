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
        "Exclusive upper bound date (YYYY-MM-DD) rounded down to its sale month. " +
          "For a full calendar month use the first of the NEXT month, e.g. all of April 2026 = until 2026-05-01. " +
          "Maturity is still enforced, so recent sale months are excluded even when until is provided.",
      )
      .optional(),
    top: z.coerce.number().int().min(1).max(100).optional(),
    minQty: z.coerce.number().int().min(1).optional(),
    maturityDays: z.coerce.number().int().min(0).max(180).optional(),
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

const outputSchema = z.object({
  rows: z.array(rowSchema),
  asOfDate: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  coveredThrough: z.string().nullable(),
  maturityDays: z.number(),
  windowIncludesImmature: z.boolean(),
  cohortBasis: z.literal("sale_month").optional(),
  requestedStartMonth: z.string().optional(),
  firstImmatureMonth: z.string().optional(),
  matureThroughMonth: z.string().nullable().optional(),
  allImmature: z.boolean().optional(),
});

export type DwsReturnRateByStyleInput = z.infer<typeof inputSchema>;
export type DwsReturnRateByStyleOutput = z.infer<typeof outputSchema>;

type ReturnRateByStyleRequest = Extract<Parameters<typeof queryDws>[1], { op: "returnRateByStyle" }> & {
  until?: string;
  maturityDays?: number;
};

async function handler(ctx: ExecutionContext, input: DwsReturnRateByStyleInput): Promise<DwsReturnRateByStyleOutput> {
  const request: ReturnRateByStyleRequest = {
    op: "returnRateByStyle",
    account: shopToAccount(input.shop),
    since: input.since,
    until: input.until,
    top: input.top ?? 20,
    minQty: input.minQty ?? 50,
    maturityDays: input.maturityDays ?? 45,
    style: input.style,
  };
  const result = await queryDws(ctx.companyId, request);
  return outputSchema.parse(result);
}

export const returnRateByStyleDescriptor: ToolDescriptor<DwsReturnRateByStyleInput, DwsReturnRateByStyleOutput> = {
  id: "dws.returnRateByStyle",
  cliSubcommand: "return-rate-by-style",
  source: "dws",
  description:
    "Amazon per-shop observed return rate by sale-month cohort for style code (sku_left7), using " +
    "dws_od_amazon_refund_rate_d.yearmouth. The since date is rounded down to its sale month; " +
    "until remains an exclusive upper bound rounded down to its sale month, and maturity is still " +
    "enforced even when until is provided. The tool includes mature sale-months only, with " +
    "maturityDays defaulting to 45 because recent cohorts are right-censored and usually " +
    "understate returns. Rate = SUM(rf_quantity) / SUM(quantity). New or recent styles with no " +
    "mature sale month return empty rows with allImmature=true. Omit style to rank highest-return-rate " +
    "styles after applying minQty to salesQty; pass an exact style code to query one style without " +
    "minQty/ranking. Source: single internal DW (Aliyun) table with 4yr history and broader store " +
    "coverage than Lingxing. Distinct from Lingxing return rate, which is per shop_name/SKU.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
