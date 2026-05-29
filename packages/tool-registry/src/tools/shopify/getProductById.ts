import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryShopify } from "./client.js";

const inputSchema = z
  .object({
    productId: z.string().regex(/^\d+$/, "productId must be the numeric Shopify product id"),
  })
  .strict();

const outputSchema = z.object({
  product: z.custom((value) => value !== undefined, "product is required"),
});

export type ShopifyGetProductByIdInput = z.infer<typeof inputSchema>;
export type ShopifyGetProductByIdOutput = z.infer<typeof outputSchema>;

async function handleGetProductById(
  ctx: ExecutionContext,
  input: ShopifyGetProductByIdInput,
): Promise<ShopifyGetProductByIdOutput> {
  const result = await queryShopify(ctx.companyId, { op: "getProductById", ...input });
  return outputSchema.parse(result);
}

export const getProductByIdDescriptor: ToolDescriptor<ShopifyGetProductByIdInput, ShopifyGetProductByIdOutput> = {
  id: "shopify.getProductById",
  cliSubcommand: "get-product-by-id",
  source: "shopify",
  description: "Fetch a Shopify product by its numeric product id (read-only). Complements shopify.getProduct (by handle).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["shop", "token"],
  handler: handleGetProductById,
};
