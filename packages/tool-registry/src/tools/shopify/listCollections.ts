import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryShopify } from "./client.js";

const inputSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(250).default(50),
    titleContains: z.string().min(1).max(255).optional(),
  })
  .strict();

const outputSchema = z.object({
  collections: z.array(z.unknown()),
});

export type ShopifyListCollectionsInput = z.input<typeof inputSchema>;
export type ShopifyListCollectionsOutput = z.infer<typeof outputSchema>;

async function handleListCollections(
  ctx: ExecutionContext,
  input: ShopifyListCollectionsInput,
): Promise<ShopifyListCollectionsOutput> {
  const result = await queryShopify(ctx.companyId, {
    op: "listCollections",
    limit: input.limit ?? 50,
    titleContains: input.titleContains,
  });
  return outputSchema.parse(result);
}

export const listCollectionsDescriptor: ToolDescriptor<ShopifyListCollectionsInput, ShopifyListCollectionsOutput> = {
  id: "shopify.listCollections",
  cliSubcommand: "list-collections",
  source: "shopify",
  description:
    "List Shopify collections (read-only) — merges custom + smart collections, each tagged with " +
    "collectionType. Optional titleContains filter (case-insensitive substring); when set it " +
    "deep-scans (cursor-paginated, up to ~5000 per type) so matches past page 1 are not dropped — " +
    "a store can have 1000+ smart collections. Returns up to `limit` (default 50, max 250) matches " +
    "PER collection type. Use this to discover the collectionId needed by shopify.listProductsByCollection.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["shop", "token"],
  handler: handleListCollections,
};
