import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

export type MetaRequest =
  | { op: "adAccountSummary"; accountId: string }
  | { op: "adsetPerformance"; accountId: string; since: string; until: string }
  | {
      op: "insights";
      accountId: string;
      since: string;
      until: string;
      level: "account" | "campaign" | "adset" | "ad";
      breakdowns?: string[];
      timeIncrement: "all_days" | "1";
    }
  | {
      op: "listCampaigns";
      accountId: string;
      effectiveStatus?: string[];
      limit?: number;
    }
  | {
      op: "listAds";
      accountId: string;
      campaignId?: string;
      effectiveStatus?: string[];
    };

// .strict() + array-branch first so adsetPerformance's `rows` array doesn't
// get swallowed by the first member's z.unknown() (which accepts undefined).
const metaHelperResponseSchema = z.union([
  z.object({ version: z.literal("1"), rows: z.array(z.unknown()) }).strict(),
  z.object({ version: z.literal("1"), campaigns: z.array(z.unknown()) }).strict(),
  z.object({ version: z.literal("1"), ads: z.array(z.unknown()) }).strict(),
  z.object({ version: z.literal("1"), account: z.unknown() }).strict(),
]);

export async function queryMeta(companyId: string, request: MetaRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "meta");
  return runPythonHelper({
    helperPath,
    request: { version: "1", ...request },
    responseSchema: metaHelperResponseSchema,
    envFromSecrets: {
      META_ACCESS_TOKEN: secrets.accessToken,
      META_API_VERSION: secrets.apiVersion,
    },
    timeoutMs: 25_000,
  });
}
