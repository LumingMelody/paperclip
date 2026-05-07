import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryLingxing } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE),
    days: z.coerce.number().int().min(7).max(120).optional(),
  })
  .strict();

const rowSchema = z.object({
  asin: z.string(),
  sellerSku: z.string(),
  productTitle: z.string().nullable(),
  shopName: z.string(),
  qty14d: z.number(),
  dailyAvg: z.number(),
  projectedSalesInWindow: z.number(),
});

const outputSchema = z.object({
  rows: z.array(rowSchema),
});

export type StockoutRiskInput = z.infer<typeof inputSchema>;
export type StockoutRiskOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: StockoutRiskInput): Promise<StockoutRiskOutput> {
  const result = await queryLingxing(ctx.companyId, {
    op: "stockoutRisk",
    shop: input.shop,
    days: input.days ?? 30,
  });
  return outputSchema.parse(result);
}

export const stockoutRiskDescriptor: ToolDescriptor<StockoutRiskInput, StockoutRiskOutput> = {
  id: "lingxing.stockoutRisk",
  cliSubcommand: "stockout-risk",
  source: "lingxing",
  description:
    "High-velocity SKUs in a shop that need a manual FBA stock check. " +
    "Computes 14d daily-average sales velocity and projects N-day demand. " +
    "Does NOT join live inventory (Phase 2) — surfaces 'who to look at first'.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password"],
  handler,
};
