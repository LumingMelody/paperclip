import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryLingxing } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    top: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const rowSchema = z.object({
  asin: z.string(),
  sellerSku: z.string(),
  productTitle: z.string().nullable(),
  shopName: z.string(),
  currencyCode: z.string().nullable(),
  orderQty: z.number(),
  gmvLocal: z.number(),
  adSpendLocal: z.number(),
  adSalesAmount: z.number(),
  returnCount: z.number(),
});

const outputSchema = z.object({
  rows: z.array(rowSchema),
});

export type LingxingTopSkusInput = z.infer<typeof inputSchema>;
export type LingxingTopSkusOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: LingxingTopSkusInput): Promise<LingxingTopSkusOutput> {
  const result = await queryLingxing(ctx.companyId, {
    op: "topSkus",
    shop: input.shop,
    since: input.since,
    top: input.top ?? 10,
  });
  return outputSchema.parse(result);
}

export const topSkusDescriptor: ToolDescriptor<LingxingTopSkusInput, LingxingTopSkusOutput> = {
  id: "lingxing.topSkus",
  cliSubcommand: "top-skus",
  source: "lingxing",
  description:
    "Top SKUs by GMV for a shop since a given date. Returns asin, sellerSku, " +
    "title, GMV, ad spend, return count. Use for 'best sellers last 7 days' style questions.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password"],
  handler,
};
