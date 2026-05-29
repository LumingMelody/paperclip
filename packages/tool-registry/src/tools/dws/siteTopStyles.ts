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
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    top: z.coerce.number().int().min(1).max(50).optional(),
    style: z.string().optional(),
  })
  .strict();

const rowSchema = z.object({
  styleCode: z.string().nullable(),
  salesQty: z.number(),
  skuCount: z.number(),
  productTitle: z.string().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsSiteTopStylesInput = z.infer<typeof inputSchema>;
export type DwsSiteTopStylesOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsSiteTopStylesInput): Promise<DwsSiteTopStylesOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "siteTopStyles",
    account: siteToAccount(input.site),
    since: input.since,
    top: input.top ?? 20,
    style: input.style,
  });
  return outputSchema.parse(result);
}

export const siteTopStylesDescriptor: ToolDescriptor<DwsSiteTopStylesInput, DwsSiteTopStylesOutput> = {
  id: "dws.siteTopStyles",
  cliSubcommand: "site-top-styles",
  source: "dws",
  description:
    "独立站 (Ever-Pretty Shopify DTC) top-selling style codes by UNITS sold for a site " +
    "(EPSITE US/UK/FR/DE/AU) since a date; source single Aliyun DWS table " +
    "dwa_od_shopify_sale_d, fresh T+0. UNITS ONLY (no GMV/revenue in source). Omit style " +
    "for the top-N ranking; pass a style code for one style's units. Excludes " +
    "shipping-insurance / lucky-bag placeholder SKUs. Distinct from lingxing.topSkus which " +
    "is Amazon by GMV.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
