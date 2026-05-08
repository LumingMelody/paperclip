import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

export type OmsQueryRequest =
  | { op: "salesByChannel"; since: string; until?: string }
  | { op: "b2bCustomerRanking"; since: string; until?: string; top?: number }
  | { op: "dormantB2bCustomers"; since: string; until?: string; dormancyDays?: number; includeDisabled?: boolean; top?: number }
  | { op: "inventoryByWarehouse"; sku?: string; warehouseCode?: string; country?: string; warehouseType?: string; minAvailable?: number; top?: number };

const omsHelperResponseSchema = z
  .object({
    version: z.literal("1"),
    rows: z.array(z.unknown()),
  })
  .strict();

export async function queryOms(companyId: string, request: OmsQueryRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "oms");
  const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

  return runPythonHelper({
    helperPath,
    request: {
      version: "1",
      ...request,
    },
    responseSchema: omsHelperResponseSchema,
    envFromSecrets: {
      OMS_DB_HOST: secrets.host,
      OMS_DB_PORT: secrets.port ?? "",
      OMS_DB_USER: secrets.user,
      OMS_DB_PASSWORD: secrets.password,
      OMS_DB_DATABASE: secrets.database,
    },
  });
}
