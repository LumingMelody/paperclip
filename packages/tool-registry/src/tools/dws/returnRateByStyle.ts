import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    top: z.coerce.number().int().min(1).max(50).optional(),
    minQty: z.coerce.number().int().min(1).optional(),
    style: z.string().optional(),
  })
  .strict();

const rowSchema = z.object({
  styleCode: z.string().nullable(),
  salesQty: z.number(),
  returnQty: z.number(),
  returnRate: z.number().nullable(),
  skuCount: z.number(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsReturnRateByStyleInput = z.infer<typeof inputSchema>;
export type DwsReturnRateByStyleOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsReturnRateByStyleInput): Promise<DwsReturnRateByStyleOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "returnRateByStyle",
    account: shopToAccount(input.shop),
    since: input.since,
    top: input.top ?? 20,
    minQty: input.minQty ?? 50,
    style: input.style,
  });
  return outputSchema.parse(result);
}

export const returnRateByStyleDescriptor: ToolDescriptor<DwsReturnRateByStyleInput, DwsReturnRateByStyleOutput> = {
  id: "dws.returnRateByStyle",
  cliSubcommand: "return-rate-by-style",
  source: "dws",
  description:
    "Amazon style-code (sku_left7) return rates for a shop since a given date. Omit style " +
    "to answer highest-return-rate styles; pass an exact style code to answer one specific " +
    "style's return rate. Rate = refunded units / ordered units. Source: single internal " +
    "DW (Aliyun) table with 4yr history and broader store coverage than Lingxing. Distinct " +
    "from Lingxing return rate, which is per shop_name/SKU.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
