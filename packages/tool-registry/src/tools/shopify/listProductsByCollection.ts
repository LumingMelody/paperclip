import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryShopify } from "./client.js";

const inputSchema = z
  .object({
    collectionId: z.string().min(1).max(255),
    limit: z.coerce.number().int().min(1).max(250).default(50),
  })
  .strict();

const outputSchema = z.object({
  products: z.array(z.unknown()),
});

export type ShopifyListProductsByCollectionInput = z.input<typeof inputSchema>;
export type ShopifyListProductsByCollectionOutput = z.infer<typeof outputSchema>;

async function handleListProductsByCollection(
  ctx: ExecutionContext,
  input: ShopifyListProductsByCollectionInput,
): Promise<ShopifyListProductsByCollectionOutput> {
  const result = await queryShopify(ctx.companyId, {
    op: "listProductsByCollection",
    collectionId: input.collectionId,
    limit: input.limit ?? 50,
  });
  return outputSchema.parse(result);
}

export const listProductsByCollectionDescriptor: ToolDescriptor<
  ShopifyListProductsByCollectionInput,
  ShopifyListProductsByCollectionOutput
> = {
  id: "shopify.listProductsByCollection",
  cliSubcommand: "list-products-by-collection",
  source: "shopify",
  description: "List Shopify products in a collection (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["shop", "token"],
  handler: handleListProductsByCollection,
};
