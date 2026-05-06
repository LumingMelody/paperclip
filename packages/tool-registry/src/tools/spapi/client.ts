import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

export type SpapiRequest =
  | { op: "getOrder"; orderId: string }
  | { op: "listOrdersUpdatedSince"; since: string; marketplaceId?: string; maxResults?: number };

// Strict on both branches so `z.unknown()` doesn't accidentally swallow a
// list-orders response (where `order` is undefined and `orders` is the array).
// Without .strict() the first union member matched too eagerly because
// z.unknown() accepts undefined and the orders/nextToken keys got stripped.
const spapiHelperResponseSchema = z.union([
  z.object({
    version: z.literal("1"),
    orders: z.array(z.unknown()),
    nextToken: z.string().nullable().optional(),
  }).strict(),
  z.object({ version: z.literal("1"), order: z.unknown() }).strict(),
]);

export async function querySpapi(companyId: string, request: SpapiRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "spapi");
  return runPythonHelper({
    helperPath,
    request: { version: "1", ...request },
    responseSchema: spapiHelperResponseSchema,
    envFromSecrets: {
      SPAPI_REFRESH_TOKEN: secrets.refreshToken,
      SPAPI_CLIENT_ID: secrets.clientId,
      SPAPI_CLIENT_SECRET: secrets.clientSecret,
      SPAPI_REGION: secrets.region,
      SPAPI_MARKETPLACE_ID: secrets.marketplaceId,
    },
    timeoutMs: 30_000,
  });
}
