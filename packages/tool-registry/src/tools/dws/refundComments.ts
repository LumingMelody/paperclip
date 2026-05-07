import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    skuPrefix: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const rowSchema = z.object({
  eventDate: z.string().nullable(),
  sellerSku: z.string().nullable(),
  styleCode: z.string().nullable(),
  size: z.string().nullable(),
  color: z.string().nullable(),
  returnReason: z.string().nullable(),
  customerComment: z.string().nullable(),
  quantity: z.number().nullable(),
  refundQuantity: z.number().nullable(),
  orderId: z.string().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsRefundCommentsInput = z.infer<typeof inputSchema>;
export type DwsRefundCommentsOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsRefundCommentsInput): Promise<DwsRefundCommentsOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "refundComments",
    account: shopToAccount(input.shop),
    since: input.since,
    skuPrefix: input.skuPrefix,
    limit: input.limit ?? 20,
  });
  return outputSchema.parse(result);
}

export const refundCommentsDescriptor: ToolDescriptor<DwsRefundCommentsInput, DwsRefundCommentsOutput> = {
  id: "dws.refundComments",
  cliSubcommand: "refund-comments",
  source: "dws",
  description:
    "Return events WITH the customer's free-text comment (joined from refund_rate ← dm_allretrun on order_id). " +
    "Comments include phrases like 'Zu klein' / 'Too small' / 'Material thin'. ~26% of returns have comments. " +
    "Pass skuPrefix='EE02968' to filter by style series. Use to validate WHY a return-reason code keeps appearing.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
