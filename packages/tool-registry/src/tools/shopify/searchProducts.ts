import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryShopify } from "./client.js";

const inputSchema = z
  .object({
    status: z.enum(["active", "archived", "draft"]).optional(),
    vendor: z.string().min(1).max(255).optional(),
    productType: z.string().min(1).max(255).optional(),
    collectionId: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(255).optional(),
    limit: z.coerce.number().int().min(1).max(250).default(50),
  })
  .strict();

const outputSchema = z.object({
  products: z.array(z.unknown()),
});

export type ShopifySearchProductsInput = z.input<typeof inputSchema>;
export type ShopifySearchProductsOutput = z.infer<typeof outputSchema>;

async function handleSearchProducts(
  ctx: ExecutionContext,
  input: ShopifySearchProductsInput,
): Promise<ShopifySearchProductsOutput> {
  const result = await queryShopify(ctx.companyId, {
    op: "searchProducts",
    status: input.status,
    vendor: input.vendor,
    productType: input.productType,
    collectionId: input.collectionId,
    title: input.title,
    limit: input.limit ?? 50,
  });
  return outputSchema.parse(result);
}

export const searchProductsDescriptor: ToolDescriptor<ShopifySearchProductsInput, ShopifySearchProductsOutput> = {
  id: "shopify.searchProducts",
  cliSubcommand: "search-products",
  source: "shopify",
  description:
    "Search/filter Shopify products (read-only) by status (active/archived/draft), vendor, " +
    "productType, collectionId, or title. NOTE: `title` is an EXACT match (REST limitation); " +
    "substring/full-text search needs the GraphQL Admin API which is not yet wired. Returns up " +
    "to `limit` (default 50, max 250) products.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["shop", "token"],
  handler: handleSearchProducts,
};
