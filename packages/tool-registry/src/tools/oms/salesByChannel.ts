import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryOms } from "./client.js";

const inputSchema = z
  .object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD").optional(),
  })
  .strict();

const rowSchema = z.object({
  salesChannel: z.string(),
  currency: z.string().nullable(),
  orderCount: z.number(),
  gmv: z.number(),
  shipAmount: z.number(),
  discountAmount: z.number(),
  avgOrderValue: z.number().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type OmsSalesByChannelInput = z.infer<typeof inputSchema>;
export type OmsSalesByChannelOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: OmsSalesByChannelInput): Promise<OmsSalesByChannelOutput> {
  const result = await queryOms(ctx.companyId, {
    op: "salesByChannel",
    since: input.since,
    until: input.until,
  });
  return outputSchema.parse(result);
}

export const salesByChannelDescriptor: ToolDescriptor<OmsSalesByChannelInput, OmsSalesByChannelOutput> = {
  id: "oms.salesByChannel",
  cliSubcommand: "sales-by-channel",
  source: "oms",
  description:
    "Cross-channel GMV breakdown from the Ever-Pretty unified OMS (kdls-oms-backend). " +
    "Groups by sales_channel (Amazon.com / Amazon.de / Amazon.co.uk / Shopify / SHEIN / TikTok / etc.) " +
    "and currency, returning order count, GMV, shipping and discount totals over an order_date range. " +
    "Source: internal OMS MySQL — covers ALL channels including B2B Shopify draft orders, " +
    "complementing Lingxing (which only has Amazon ledger view).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
