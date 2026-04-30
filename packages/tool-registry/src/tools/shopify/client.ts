import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

export type ShopifyRequest =
  | { op: "getProduct"; handle: string }
  | { op: "listProductsByCollection"; collectionId: string; limit?: number };

const shopifyHelperResponseSchema = z.union([
  z.object({ version: z.literal("1"), product: z.unknown() }),
  z.object({ version: z.literal("1"), products: z.array(z.unknown()) }),
]);

export async function queryShopify(companyId: string, request: ShopifyRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "shopify");
  return runPythonHelper({
    helperPath,
    request: { version: "1", ...request },
    responseSchema: shopifyHelperResponseSchema,
    envFromSecrets: {
      SHOPIFY_SHOP: secrets.shop,
      SHOPIFY_TOKEN: secrets.token,
      SHOPIFY_API_VERSION: secrets.apiVersion,
    },
    timeoutMs: 25_000,
  });
}
