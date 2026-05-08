import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryFba, shopToStore } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    sku: z.string().min(1),
    days: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strict();

const rowSchema = z.object({
  reportDate: z.string().nullable(),
  sku: z.string().nullable(),
  asin: z.string().nullable(),
  store: z.string().nullable(),
  fulfillableQty: z.number().nullable(),
  totalQty: z.number().nullable(),
  price: z.number().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type FbaSnapshotHistoryInput = z.infer<typeof inputSchema>;
export type FbaSnapshotHistoryOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: FbaSnapshotHistoryInput): Promise<FbaSnapshotHistoryOutput> {
  const result = await queryFba(ctx.companyId, {
    op: "snapshotHistory",
    store: shopToStore(input.shop),
    sku: input.sku,
    days: input.days ?? 30,
  });
  return outputSchema.parse(result);
}

export const snapshotHistoryDescriptor: ToolDescriptor<FbaSnapshotHistoryInput, FbaSnapshotHistoryOutput> = {
  id: "fba.snapshotHistory",
  cliSubcommand: "snapshot-history",
  source: "fba",
  description:
    "Per-SKU FBA inventory history (afn_fulfillable_quantity over time). Use for trend analysis: 'EE02968 库存最近 30 天怎么变化的'. " +
    "Source: T_amazon_fba_inventory_snapshot (history table populated by Aws_spider's daily sync).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
