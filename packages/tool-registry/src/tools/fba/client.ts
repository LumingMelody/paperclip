import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

export type FbaQueryRequest =
  | { op: "currentInventory"; store: string; sku?: string; top?: number }
  | { op: "lowStock"; store: string; fulfillableLessThan: number; top?: number }
  | { op: "snapshotHistory"; store: string; sku: string; days?: number };

const fbaHelperResponseSchema = z
  .object({
    version: z.literal("1"),
    rows: z.array(z.unknown()),
  })
  .strict();

const SHOP_RE = /^(EP|PZ|DAMA)-([A-Z]{2})$/;

/** Translate LLM-facing shop code to FBA `store` field value
 *  EP-US → EPUS, PZ-US → PZUS, DAMA-US → DaMaUS */
export function shopToStore(shop: string): string {
  const m = SHOP_RE.exec(shop);
  if (!m) {
    throw new Error(`shop must match /^(EP|PZ|DAMA)-[A-Z]{2}$/, got ${shop}`);
  }
  const brand = m[1];
  const country = m[2];
  if (brand === "DAMA") return `DaMa${country}`;
  return `${brand}${country}`;
}

export async function queryFba(companyId: string, request: FbaQueryRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "fba");
  const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

  return runPythonHelper({
    helperPath,
    request: {
      version: "1",
      ...request,
    },
    responseSchema: fbaHelperResponseSchema,
    envFromSecrets: {
      FBA_DB_HOST: secrets.host,
      FBA_DB_PORT: secrets.port ?? "",
      FBA_DB_USER: secrets.user,
      FBA_DB_PASSWORD: secrets.password,
      FBA_DB_DATABASE: secrets.database,
    },
  });
}
