import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryShopify } from "./client.js";

const inputSchema = z
  .object({
    handle: z.string().regex(/^[a-z0-9-]+$/, "handle must be lowercase kebab-case").min(1).max(255),
  })
  .strict();

const outputSchema = z.object({
  product: z.custom((value) => value !== undefined, "product is required"),
});

export type ShopifyGetProductInput = z.infer<typeof inputSchema>;
export type ShopifyGetProductOutput = z.infer<typeof outputSchema>;

async function handleGetProduct(ctx: ExecutionContext, input: ShopifyGetProductInput): Promise<ShopifyGetProductOutput> {
  const result = await queryShopify(ctx.companyId, { op: "getProduct", ...input });
  return outputSchema.parse(result);
}

export const getProductDescriptor: ToolDescriptor<ShopifyGetProductInput, ShopifyGetProductOutput> = {
  id: "shopify.getProduct",
  cliSubcommand: "get-product",
  source: "shopify",
  description: "Fetch a Shopify product by handle (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["shop", "token"],
  handler: handleGetProduct,
};
