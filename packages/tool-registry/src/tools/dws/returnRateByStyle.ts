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
        "Exclusive upper bound date (YYYY-MM-DD): matches check_date >= since AND check_date < until. " +
          "For a full calendar month use the first of the NEXT month, e.g. all of April 2026 = until 2026-05-01. " +
          "Output coveredThrough echoes the inclusive last day (2026-04-30).",
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
  coveredThrough: z.string(),
  maturityDays: z.number(),
  windowIncludesImmature: z.boolean(),
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
    "Amazon style-code (sku_left7) return rates for a shop over a closed-open order window: " +
    "check_date >= since and check_date < until. Pass until for retrospective fixed-window " +
    "reports such as one calendar month. If until is omitted, the tool defaults to mature " +
    "cohorts only by ending the window at CURDATE() - maturityDays, with maturityDays defaulting " +
    "to 45 because recent orders are right-censored and usually understate returns. Omit style " +
    "to rank highest-return-rate styles after applying minQty to real salesQty inside the window; " +
    "pass an exact style code to query one style without minQty/ranking. Rate = refunded units / " +
    "ordered units. Source: single internal DW (Aliyun) table with 4yr history and broader store " +
    "coverage than Lingxing. Distinct from Lingxing return rate, which is per shop_name/SKU.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
