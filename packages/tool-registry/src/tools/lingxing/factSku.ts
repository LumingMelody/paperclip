import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import { NotFound, UpstreamError, ValidationError } from "../../errors.js";
import { runTool } from "../../executor.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryLingxing } from "./client.js";

const factSkuInputSchema = z
  .object({
    asin: z.string().regex(/^[A-Z0-9]{10}$/),
  })
  .strict();

const factSkuRowSchema = z
  .object({
    asin: z.string(),
    parentAsin: z.string().nullable(),
    sellerSku: z.string().nullable(),
    productTitle: z.string().nullable(),
    shopSid: z.coerce.number().nullable(),
    shopName: z.string().nullable(),
    currencyCode: z.string().nullable(),
    firstSeen: z.string().nullable(),
    lastSeen: z.string().nullable(),
    orderQty: z.coerce.number(),
    gmvLocal: z.coerce.number(),
    returnCount: z.coerce.number(),
    avgRating: z.coerce.number().nullable(),
    reviewsCount: z.coerce.number().nullable(),
  })
  .strict();

const factSkuResponseSchema = z
  .object({
    version: z.literal("1").optional(),
    row: factSkuRowSchema.nullable(),
  })
  .strict();

export type FactSkuInput = z.infer<typeof factSkuInputSchema>;
export type FactSkuRow = z.infer<typeof factSkuRowSchema>;

function parseFactSkuInput(input: unknown): FactSkuInput {
  const parsed = factSkuInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Invalid lingxing.factSku input: ${parsed.error.issues[0]?.message ?? "invalid input"}`);
  }
  return parsed.data;
}

async function handleFactSku(ctx: ExecutionContext, input: FactSkuInput): Promise<FactSkuRow> {
  const response = await queryLingxing(ctx.companyId, {
    op: "factSku",
    asin: input.asin,
  });
  const parsedResponse = factSkuResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new UpstreamError("Lingxing factSku returned an unexpected response shape");
  }
  if (!parsedResponse.data.row) {
    throw new NotFound(`No Lingxing SKU row found for ASIN ${input.asin}`);
  }
  return parsedResponse.data.row;
}

export const factSkuDescriptor: ToolDescriptor<FactSkuInput, FactSkuRow> = {
  id: "lingxing.factSku",
  cliSubcommand: "fact-sku",
  source: "lingxing",
  description: "Read Lingxing SKU facts for an Amazon ASIN.",
  readOnly: true,
  inputSchema: factSkuInputSchema,
  outputSchema: factSkuRowSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler: handleFactSku,
};

export async function factSku(ctx: ExecutionContext, input: unknown): Promise<FactSkuRow> {
  return runTool(ctx, async () => handleFactSku(ctx, parseFactSkuInput(input)));
}
