import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import { UpstreamError, ValidationError } from "../../errors.js";
import { runTool } from "../../executor.js";
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

export async function factOrders(ctx: ExecutionContext, input: unknown): Promise<FactOrderRow[]> {
  return runTool(ctx, async () => {
    const parsedInput = parseFactOrdersInput(input);
    const response = await queryLingxing(ctx.companyId, {
      op: "factOrders",
      skuId: parsedInput.skuId,
      since: parsedInput.since,
    });
    const parsedResponse = factOrdersResponseSchema.safeParse(response);
    if (!parsedResponse.success) {
      throw new UpstreamError("Lingxing factOrders returned an unexpected response shape");
    }
    return parsedResponse.data.rows;
  });
}
