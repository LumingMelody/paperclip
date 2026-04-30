import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import { UpstreamError, ValidationError } from "../../errors.js";
import { runTool } from "../../executor.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryLingxing } from "./client.js";

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value) && !Number.isNaN(Date.parse(value));
}

const factOrdersInputSchema = z
  .object({
    skuId: z.string().min(1),
    since: z.string().refine(isIsoDate, "Expected an ISO date string"),
  })
  .strict();

const factOrderRowSchema = z
  .object({
    skuId: z.string(),
    asin: z.string().nullable(),
    startDate: z.string(),
    endDate: z.string(),
    orderQty: z.coerce.number(),
    gmvLocal: z.coerce.number(),
    returnCount: z.coerce.number(),
    orderItems: z.coerce.number().nullable(),
    avgSellingPrice: z.coerce.number().nullable(),
    adSpendLocal: z.coerce.number().nullable(),
    adSalesAmount: z.coerce.number().nullable(),
  })
  .strict();

const factOrdersResponseSchema = z
  .object({
    version: z.literal("1").optional(),
    rows: z.array(factOrderRowSchema),
  })
  .strict();

export type FactOrdersInput = z.infer<typeof factOrdersInputSchema>;
export type FactOrderRow = z.infer<typeof factOrderRowSchema>;

function parseFactOrdersInput(input: unknown): FactOrdersInput {
  const parsed = factOrdersInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid lingxing.factOrders input: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
    );
  }
  return parsed.data;
}

async function handleFactOrders(ctx: ExecutionContext, input: FactOrdersInput): Promise<FactOrderRow[]> {
  const response = await queryLingxing(ctx.companyId, {
    op: "factOrders",
    skuId: input.skuId,
    since: input.since,
  });
  const parsedResponse = factOrdersResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new UpstreamError("Lingxing factOrders returned an unexpected response shape");
  }
  return parsedResponse.data.rows;
}

export const factOrdersDescriptor: ToolDescriptor<FactOrdersInput, FactOrderRow[]> = {
  id: "lingxing.factOrders",
  cliSubcommand: "fact-orders",
  source: "lingxing",
  description: "Read Lingxing order facts for a seller SKU since an ISO date.",
  readOnly: true,
  inputSchema: factOrdersInputSchema,
  outputSchema: z.array(factOrderRowSchema),
  requiredSecrets: ["host", "user", "password", "database"],
  handler: handleFactOrders,
};

export async function factOrders(ctx: ExecutionContext, input: unknown): Promise<FactOrderRow[]> {
  return runTool(ctx, async () => handleFactOrders(ctx, parseFactOrdersInput(input)));
}
