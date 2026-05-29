import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws } from "./client.js";

const SITE_RE = /^(US|UK|FR|DE|AU)$/;

function siteToAccount(site: string): string {
  if (!SITE_RE.test(site)) {
    throw new Error(`site must be one of US/UK/FR/DE/AU (独立站), got ${site}`);
  }
  return `EPSITE${site}`;
}

const inputSchema = z
  .object({
    site: z.string().regex(SITE_RE, "site must be one of US/UK/FR/DE/AU (独立站)"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD").optional(),
    windowDays: z.coerce.number().int().min(1).max(180).optional(),
    top: z.coerce.number().int().min(1).max(50).optional(),
    minQty: z.coerce.number().int().min(1).optional(),
    sort: z.enum(["decline", "slow"]).optional(),
  })
  .strict();

const rowSchema = z.object({
  styleCode: z.string().nullable(),
  recentQty: z.number(),
  priorQty: z.number(),
  deltaQty: z.number(),
  dropPct: z.number().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsSiteSlowMoversInput = z.infer<typeof inputSchema>;
export type DwsSiteSlowMoversOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsSiteSlowMoversInput): Promise<DwsSiteSlowMoversOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "siteSlowMovers",
    account: siteToAccount(input.site),
    until: input.until,
    windowDays: input.windowDays ?? 30,
    top: input.top ?? 20,
    minQty: input.minQty ?? 30,
    sort: input.sort ?? "decline",
  });
  return outputSchema.parse(result);
}

export const siteSlowMoversDescriptor: ToolDescriptor<DwsSiteSlowMoversInput, DwsSiteSlowMoversOutput> = {
  id: "dws.siteSlowMovers",
  cliSubcommand: "site-slow-movers",
  source: "dws",
  description:
    "独立站 (Ever-Pretty Shopify DTC) declining / slow-moving style codes — compares the recent " +
    "windowDays of units sold vs the immediately-preceding equal window per style. sort=decline " +
    "(default) ranks the biggest unit drops; sort=slow ranks lowest recent volume. Only styles " +
    "with priorQty>=minQty (default 30) so it flags real declines, not noise. Source single " +
    "Aliyun DWS table dwa_od_shopify_sale_d, fresh T+0. UNITS ONLY (no GMV/revenue in source). " +
    "Use to find 停售 / 促销 / 下架 candidates. Distinct from dws.siteTopStyles (top sellers).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
