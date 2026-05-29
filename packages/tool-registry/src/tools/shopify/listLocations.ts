import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryShopify } from "./client.js";

const inputSchema = z.object({}).strict();

const outputSchema = z.object({
  locations: z.array(z.unknown()),
});

export type ShopifyListLocationsInput = z.infer<typeof inputSchema>;
export type ShopifyListLocationsOutput = z.infer<typeof outputSchema>;

async function handleListLocations(
  ctx: ExecutionContext,
  _input: ShopifyListLocationsInput,
): Promise<ShopifyListLocationsOutput> {
  const result = await queryShopify(ctx.companyId, { op: "listLocations" });
  return outputSchema.parse(result);
}

export const listLocationsDescriptor: ToolDescriptor<ShopifyListLocationsInput, ShopifyListLocationsOutput> = {
  id: "shopify.listLocations",
  cliSubcommand: "list-locations",
  source: "shopify",
  description:
    "List Shopify inventory locations (read-only): id, name, active. Prerequisite read for any " +
    "future inventory-quantity operation (which needs a location id).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["shop", "token"],
  handler: handleListLocations,
};
