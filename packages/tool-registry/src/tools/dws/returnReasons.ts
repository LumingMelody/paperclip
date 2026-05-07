import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryDws, shopToAccount } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z.string().regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    sku: z.string().optional(),
    top: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const rowSchema = z.object({
  returnReason: z.string().nullable(),
  returnCount: z.number(),
  skuCount: z.number(),
  orderCount: z.number(),
  unitsReturned: z.number(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type DwsReturnReasonsInput = z.infer<typeof inputSchema>;
export type DwsReturnReasonsOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: DwsReturnReasonsInput): Promise<DwsReturnReasonsOutput> {
  const result = await queryDws(ctx.companyId, {
    op: "returnReasons",
    account: shopToAccount(input.shop),
    since: input.since,
    sku: input.sku,
    top: input.top ?? 10,
  });
  return outputSchema.parse(result);
}

export const returnReasonsDescriptor: ToolDescriptor<DwsReturnReasonsInput, DwsReturnReasonsOutput> = {
  id: "dws.returnReasons",
  cliSubcommand: "return-reasons",
  source: "dws",
  description:
    "Distribution of Amazon native return reason codes (e.g. APPAREL_TOO_SMALL, " +
    "DID_NOT_LIKE_FABRIC, NOT_AS_DESCRIBED) for a shop since a given date. " +
    "Optionally filter by sku. Use to answer 'why is EP-US returning so much' / " +
    "'what fraction of returns is sizing'. Source: internal DW (Aliyun) — " +
    "Lingxing API does NOT expose these reason codes.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
