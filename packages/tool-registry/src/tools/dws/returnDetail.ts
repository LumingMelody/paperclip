import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    sku: z.string().min(1),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const rowSchema = z.object({
  eventDate: z.string().nullable(),
  sku: z.string().nullable(),
  orderId: z.string().nullable(),
  rma: z.string().nullable(),
  quantity: z.number().nullable(),
  refundQuantity: z.number().nullable(),
  returnReason: z.string().nullable(),
  reasonDescription: z.string().nullable(),
  owner: z.string().nullable(),
  warehouse: z.string().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsReturnDetailInput = z.infer<typeof inputSchema>;
export type DwsReturnDetailOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsReturnDetailInput): Promise<DwsReturnDetailOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "returnDetail",
    account: shopToAccount(input.shop),
    sku: input.sku,
    since: input.since,
    limit: input.limit ?? 20,
  });
  return outputSchema.parse(result);
}

export const returnDetailDescriptor: ToolDescriptor<DwsReturnDetailInput, DwsReturnDetailOutput> = {
  id: "dws.returnDetail",
  cliSubcommand: "return-detail",
  source: "dws",
  description:
    "Per-SKU return event log: date, orderId, rma, qty, return reason code, and " +
    "free-text customer description (when available). Use after returnsBySku to " +
    "drill into a specific SKU's recent returns and surface what customers actually said.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
