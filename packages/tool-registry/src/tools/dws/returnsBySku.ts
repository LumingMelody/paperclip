import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    top: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const rowSchema = z.object({
  sku: z.string(),
  returnCount: z.number(),
  unitsReturned: z.number(),
  orderCount: z.number(),
  topReason: z.string().nullable(),
  topReasonCount: z.number().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsReturnsBySkuInput = z.infer<typeof inputSchema>;
export type DwsReturnsBySkuOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsReturnsBySkuInput): Promise<DwsReturnsBySkuOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "returnsBySku",
    account: shopToAccount(input.shop),
    since: input.since,
    top: input.top ?? 20,
  });
  return outputSchema.parse(result);
}

export const returnsBySkuDescriptor: ToolDescriptor<DwsReturnsBySkuInput, DwsReturnsBySkuOutput> = {
  id: "dws.returnsBySku",
  cliSubcommand: "returns-by-sku",
  source: "dws",
  description:
    "Top SKUs by return event count for a shop since a given date, with each " +
    "SKU's dominant Amazon return reason code. Use for 'which SKUs are returning " +
    "the most and why' style questions. Pair with lingxing.topSkus to compute " +
    "return rate (returnCount / orderQty).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
