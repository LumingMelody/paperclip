import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

export type DwsQueryRequest =
  | { op: "returnReasons"; account: string; since: string; sku?: string; top?: number }
  | { op: "returnsBySku"; account: string; since: string; top?: number }
  | { op: "returnDetail"; account: string; sku: string; since: string; limit?: number }
  | { op: "refundComments"; account: string; since: string; skuPrefix?: string; limit?: number }
  | { op: "returnTrend"; account: string; since: string; until: string; granularity?: "day" | "week" | "month" };

const dwsHelperResponseSchema = z
  .object({
    version: z.literal("1"),
    rows: z.array(z.unknown()),
  })
  .strict();

const SHOP_RE = /^(EP|PZ|DAMA)-([A-Z]{2})$/;

/** Translate LLM-facing shop code (EP-US) to DWS Account name (AmazonEPUS). */
export function shopToAccount(shop: string): string {
  const m = SHOP_RE.exec(shop);
  if (!m) {
    throw new Error(`shop must match /^(EP|PZ|DAMA)-[A-Z]{2}$/, got ${shop}`);
  }
  return `Amazon${m[1]}${m[2]}`;
}

export async function queryDws(companyId: string, request: DwsQueryRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "dws");
  const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

  return runPythonHelper({
    helperPath,
    request: {
      version: "1",
      ...request,
    },
    responseSchema: dwsHelperResponseSchema,
    envFromSecrets: {
      DWS_DB_HOST: secrets.host,
      DWS_DB_PORT: secrets.port ?? "",
      DWS_DB_USER: secrets.user,
      DWS_DB_PASSWORD: secrets.password,
      DWS_DB_DATABASE: secrets.database,
    },
  });
}
