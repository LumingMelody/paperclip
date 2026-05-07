import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD"),
    granularity: z.enum(["day", "week", "month"]).optional(),
  })
  .strict();

const rowSchema = z.object({
  period: z.string(),
  returnCount: z.number(),
  unitsReturned: z.number(),
  skuCount: z.number(),
  orderCount: z.number(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsReturnTrendInput = z.infer<typeof inputSchema>;
export type DwsReturnTrendOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsReturnTrendInput): Promise<DwsReturnTrendOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "returnTrend",
    account: shopToAccount(input.shop),
    since: input.since,
    until: input.until,
    granularity: input.granularity ?? "week",
  });
  return outputSchema.parse(result);
}

export const returnTrendDescriptor: ToolDescriptor<DwsReturnTrendInput, DwsReturnTrendOutput> = {
  id: "dws.returnTrend",
  cliSubcommand: "return-trend",
  source: "dws",
  description:
    "Aggregated return event count by week / month / day for a shop within a date range. " +
    "Use for trend questions: 'EP-US 退货是不是比上月涨了' / 'EE02968 系列退货量周环比'. " +
    "granularity defaults to 'week'. Period format: 'YYYY-Www' for week, 'YYYY-MM' for month.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
