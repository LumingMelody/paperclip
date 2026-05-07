import { z, type ZodSchema } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    // CLI/pcl_runner passes arrays as JSON-encoded strings; LLM JSON args path passes real arrays.
    reasons: z
      .union([z.array(z.string().min(1)), z.string().min(1)])
      .transform((v) => {
        if (Array.isArray(v)) return v;
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed)) return parsed.map((x) => String(x));
        } catch {}
        return v.split(",").map((s) => s.trim()).filter(Boolean);
      })
      .pipe(z.array(z.string().min(1)).min(1).max(10)),
    top: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const rowSchema = z.object({
  sku: z.string(),
  reasonReturnCount: z.number(),
  reasonUnitsReturned: z.number(),
  totalReturnCount: z.number(),
  totalUnitsReturned: z.number(),
  reasonShareOfSku: z.number(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsSkusByReasonInput = z.infer<typeof inputSchema>;
export type DwsSkusByReasonOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsSkusByReasonInput): Promise<DwsSkusByReasonOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "skusByReason",
    account: shopToAccount(input.shop),
    since: input.since,
    reasons: input.reasons,
    top: input.top ?? 10,
  });
  return outputSchema.parse(result);
}

export const skusByReasonDescriptor: ToolDescriptor<DwsSkusByReasonInput, DwsSkusByReasonOutput> = {
  id: "dws.skusByReason",
  cliSubcommand: "skus-by-reason",
  source: "dws",
  description:
    "Top SKUs filtered by SPECIFIC return reason code(s). Returns rows with reasonReturnCount " +
    "(returns matching the filter), totalReturnCount (all returns), and reasonShareOfSku (ratio). " +
    "Use when user asks 'Top SKUs by 偏小 / 偏大 / 颜色问题 / 质量问题' — these need filtering by a " +
    "reason GROUP, NOT just looking at each SKU's dominant reason. " +
    "Common reason groups (pass as `reasons` array): " +
    "偏小=['APPAREL_TOO_SMALL','AMZ-PG-APP-TOO-SMALL']; " +
    "偏大=['APPAREL_TOO_LARGE','AMZ-PG-APP-TOO-LARGE']; " +
    "颜色=['DID_NOT_LIKE_COLOR']; 面料=['DID_NOT_LIKE_FABRIC']; " +
    "款式=['APPAREL_STYLE','AMZ-PG-APP-STYLE']; 质量=['QUALITY_UNACCEPTABLE']; " +
    "描述不符=['NOT_AS_DESCRIBED','AMZ-PG-BAD-DESC']; 不想要=['UNWANTED_ITEM','CR-UNWANTED_ITEM'].",
  readOnly: true,
  // Cast: zod's transform pipeline makes input≠output type, but ToolDescriptor's
  // ZodSchema<I> generic requires input==output. Runtime is identical to a
  // plain z.object — only the .d.ts shape differs.
  inputSchema: inputSchema as unknown as ZodSchema<DwsSkusByReasonInput>,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
