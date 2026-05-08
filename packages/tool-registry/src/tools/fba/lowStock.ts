import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryFba, shopToStore } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    fulfillableLessThan: z.coerce.number().int().min(0).max(10000),
    top: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const rowSchema = z.object({
  sku: z.string().nullable(),
  asin: z.string().nullable(),
  store: z.string().nullable(),
  fulfillableQty: z.number().nullable(),
  totalQty: z.number().nullable(),
  price: z.number().nullable(),
  updatedAt: z.string().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type FbaLowStockInput = z.infer<typeof inputSchema>;
export type FbaLowStockOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: FbaLowStockInput): Promise<FbaLowStockOutput> {
  const result = await queryFba(ctx.companyId, {
    op: "lowStock",
    store: shopToStore(input.shop),
    fulfillableLessThan: input.fulfillableLessThan,
    top: input.top ?? 50,
  });
  return outputSchema.parse(result);
}

export const lowStockDescriptor: ToolDescriptor<FbaLowStockInput, FbaLowStockOutput> = {
  id: "fba.lowStock",
  cliSubcommand: "low-stock",
  source: "fba",
  description:
    "SKUs in a shop with FBA fulfillable_quantity below a threshold. Use for 'who's about to stockout' decisions. " +
    "Pair with lingxing.stockoutRisk to combine actual stock with sales-velocity projections.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
