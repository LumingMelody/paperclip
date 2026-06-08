import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws } from "./client.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z
  .object({
    since: z.string().regex(DATE_RE, "since must be YYYY-MM-DD"),
    until: z
      .string()
      .regex(DATE_RE, "until must be YYYY-MM-DD")
      .describe(
        "Exclusive upper bound date (YYYY-MM-DD): matches statistic_time_local >= since AND statistic_time_local < until. " +
          "For a full calendar month use the first of the NEXT month, e.g. all of April 2026 = until 2026-05-01. " +
          "Output coveredThrough echoes the inclusive last day (2026-04-30). " +
          "For one style's GMV/units/orders in the date window, also pass style='EG02778'; add account='AmazonEPUS' to scope to one shop.",
      )
      .optional(),
    groupBy: z.enum(["platform", "account", "bu", "country", "day", "month", "style", "none"]).default("platform"),
    platform: z.string().optional(),
    account: z
      .string()
      .describe("Exact dwa_od_order_d_v1 Account value. Example: account='AmazonEPUS' to scope to one shop.")
      .optional(),
    style: z
      .string()
      .length(7, "style must be a 7-character style code")
      .describe("7-character style code. Example: pass style='EG02778' for one style's GMV/units/orders.")
      .optional(),
    top: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const rowSchema = z.object({
  groupKey: z.string().nullable(),
  currency: z.string().nullable(),
  gmv: z.number(),
  units: z.number(),
  orderCount: z.number(),
  refundAmount: z.number(),
  refundRate: z.number().nullable(),
  netSales: z.number(),
});

const outputSchema = z.object({
  rows: z.array(rowSchema),
  asOfDate: z.string(),
  windowStart: z.string(),
  windowEnd: z.string().nullable(),
  coveredThrough: z.string().nullable(),
});

export type DwsSalesSummaryInput = z.input<typeof inputSchema>;
export type DwsSalesSummaryOutput = z.infer<typeof outputSchema>;

type SalesSummaryRequest = Extract<Parameters<typeof queryDws>[1], { op: "salesSummary" }> & {
  until?: string;
  top?: number;
};

async function handler(ctx: ExecutionContext, input: DwsSalesSummaryInput): Promise<DwsSalesSummaryOutput> {
  const request: SalesSummaryRequest = {
    op: "salesSummary",
    since: input.since,
    until: input.until,
    groupBy: input.groupBy ?? "platform",
    platform: input.platform,
    account: input.account,
    style: input.style,
    top: input.top,
  };
  const result = await queryDws(ctx.companyId, request);
  return outputSchema.parse(result);
}

export const salesSummaryDescriptor: ToolDescriptor<DwsSalesSummaryInput, DwsSalesSummaryOutput> = {
  id: "dws.salesSummary",
  cliSubcommand: "sales-summary",
  source: "dws",
  description:
    "THE canonical company-wide 销售额/GMV, 订单数, 销量(units) across ALL platforms (Amazon+Shopify+Shein+易仓), " +
    "from the unified order wide table dwa_od_order_d_v1. Prefer this for any general sales / GMV / order / unit-volume question. " +
    "GMV is PER-CURRENCY: every row carries currency, and you must NEVER sum gmv across rows with different currency values. " +
    "Also returns 退款金额(refundAmount), 订单退款率(refundRate), and 净销售额(netSales) per dwa_od_order_d §8: " +
    "refundRate is ORDER-level distinct refunded orders / distinct orders; netSales = GMV - refundAmount within the same window+currency cohort. " +
    "refundAmount/netSales are PER-CURRENCY and must not be summed across rows with different currency values. " +
    "units/orderCount may be summed across currencies. " +
    "Also use it for single-style / per-SKU-family GMV from this canonical wide table: pass style='EG02778' for one style's " +
    "GMV/units/orders, and account='AmazonEPUS' to scope to one shop. " +
    "GMV excludes gift cards (is_allcard=0); units exclude YS% insurance SKUs; one order_id spans multiple rows so orders use " +
    "COUNT(DISTINCT); no-SKU financial rows are excluded. Time dimension = statistic_time_local. Other GMV tools are niche: " +
    "oms.salesByChannel = OMS-internal view, lingxing.* = Amazon ad-ledger per-SKU — they may differ; do not use them for company-wide totals.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
