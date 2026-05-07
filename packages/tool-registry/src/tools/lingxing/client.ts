import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

export type LingxingQueryRequest =
  | {
      op: "factSku";
      asin: string;
    }
  | {
      op: "factOrders";
      skuId: string;
      since: string;
    }
  | {
      op: "topSkus";
      shop: string;
      since: string;
      top?: number;
    }
  | {
      op: "stockoutRisk";
      shop: string;
      days?: number;
    };

const lingxingHelperResponseSchema = z.union([
  z
    .object({
      version: z.literal("1"),
      row: z.unknown().nullable(),
    })
    .strict(),
  z
    .object({
      version: z.literal("1"),
      rows: z.array(z.unknown()),
    })
    .strict(),
]);

export async function queryLingxing(companyId: string, request: LingxingQueryRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "lingxing");
  const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

  return runPythonHelper({
    helperPath,
    request: {
      version: "1",
      ...request,
    },
    responseSchema: lingxingHelperResponseSchema,
    envFromSecrets: {
      LINGXING_DB_HOST: secrets.host,
      LINGXING_DB_PORT: secrets.port ?? "",
      LINGXING_DB_USER: secrets.user,
      LINGXING_DB_PASSWORD: secrets.password,
      LINGXING_DB_DATABASE: secrets.database,
    },
  });
}
