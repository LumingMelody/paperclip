import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryOms } from "./client.js";

const inputSchema = z
  .object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD").optional(),
    top: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const rowSchema = z.object({
  customerEmail: z.string(),
  customerName: z.string().nullable(),
  customerState: z.string().nullable(),
  orderCount: z.number(),
  totalGmv: z.number(),
  avgOrderValue: z.number(),
  currency: z.string().nullable(),
  firstOrderDate: z.string().nullable(),
  lastOrderDate: z.string().nullable(),
  daysSinceLastOrder: z.number().nullable(),
  paidCount: z.number(),
  refundedCount: z.number(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type OmsB2bCustomerRankingInput = z.infer<typeof inputSchema>;
export type OmsB2bCustomerRankingOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: OmsB2bCustomerRankingInput): Promise<OmsB2bCustomerRankingOutput> {
  const result = await queryOms(ctx.companyId, {
    op: "b2bCustomerRanking",
    since: input.since,
    until: input.until,
    top: input.top ?? 20,
  });
  return outputSchema.parse(result);
}

export const b2bCustomerRankingDescriptor: ToolDescriptor<OmsB2bCustomerRankingInput, OmsB2bCustomerRankingOutput> = {
  id: "oms.b2bCustomerRanking",
  cliSubcommand: "b2b-customer-ranking",
  source: "oms",
  description:
    "Top B2B (e4wholesale.com) customers ranked by GMV over a date range. " +
    "Identifies wholesale customers via name LIKE 'E4WHOLESALE%' in the unified OMS. " +
    "Returns per-customer order count, GMV, AOV, currency, first/last order dates, " +
    "days-since-last-order (dormancy signal), and paid/refunded counts. " +
    "Use to answer: 'who are our top wholesale buyers', 'which B2B customers stopped " +
    "ordering recently', 'B2B repeat-buyer concentration'. Source: internal kdls-oms " +
    "MySQL — no equivalent in Lingxing/DWS (those are Amazon-centric).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
