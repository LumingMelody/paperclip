import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryFba, shopToStore } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    sku: z.string().optional(),
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

export type FbaCurrentInventoryInput = z.infer<typeof inputSchema>;
export type FbaCurrentInventoryOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: FbaCurrentInventoryInput): Promise<FbaCurrentInventoryOutput> {
  const result = await queryFba(ctx.companyId, {
    op: "currentInventory",
    store: shopToStore(input.shop),
    sku: input.sku,
    top: input.top ?? 50,
  });
  return outputSchema.parse(result);
}

export const currentInventoryDescriptor: ToolDescriptor<FbaCurrentInventoryInput, FbaCurrentInventoryOutput> = {
  id: "fba.currentInventory",
  cliSubcommand: "current-inventory",
  source: "fba",
  description:
    "Real-time FBA fulfillable inventory by shop. Returns per-SKU rows with afn_fulfillable_quantity, afn_total_quantity, your_price. " +
    "Source: Aws_spider's SQL Server (192.168.0.132) — only reachable from office LAN. " +
    "Use `sku` (prefix match) to filter to a style series. Pair with lingxing.stockoutRisk for compute-vs-actual deltas.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
