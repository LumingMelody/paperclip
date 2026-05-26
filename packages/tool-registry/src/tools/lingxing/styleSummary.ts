import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import { NotFound, UpstreamError, ValidationError } from "../../errors.js";
import { runTool } from "../../executor.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryLingxing } from "./client.js";

const styleSummaryInputSchema = z
  .object({
    stylePrefix: z.string().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/),
    shop: z.string().min(1),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
  })
  .strict();

const styleSummaryVariantSchema = z
  .object({
    sku: z.string(),
    asin: z.string().nullable(),
    orderQty: z.coerce.number(),
    returnCount: z.coerce.number(),
    returnRate: z.coerce.number().nullable(),
  })
  .strict();

const styleSummaryRowSchema = z
  .object({
    orderQty: z.coerce.number(),
    returnCount: z.coerce.number(),
    returnRate: z.coerce.number().nullable(),
    gmvLocal: z.coerce.number(),
    variantCount: z.coerce.number(),
    asinCount: z.coerce.number(),
    firstSeen: z.string().nullable(),
    lastSeen: z.string().nullable(),
    asins: z.array(z.string()),
    variants: z.array(styleSummaryVariantSchema),
  })
  .strict();

const styleSummaryResponseSchema = z
  .object({
    version: z.literal("1").optional(),
    row: styleSummaryRowSchema.nullable(),
  })
  .strict();

export type StyleSummaryInput = z.infer<typeof styleSummaryInputSchema>;
export type StyleSummaryRow = z.infer<typeof styleSummaryRowSchema>;

function parseStyleSummaryInput(input: unknown): StyleSummaryInput {
  const parsed = styleSummaryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid lingxing.styleSummary input: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
    );
  }
  return parsed.data;
}

async function handleStyleSummary(ctx: ExecutionContext, input: StyleSummaryInput): Promise<StyleSummaryRow> {
  const response = await queryLingxing(ctx.companyId, {
    op: "styleSummary",
    stylePrefix: input.stylePrefix,
    shop: input.shop,
    since: input.since,
  });
  const parsedResponse = styleSummaryResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new UpstreamError("Lingxing styleSummary returned an unexpected response shape");
  }
  if (!parsedResponse.data.row) {
    throw new NotFound(`No Lingxing style rows found for ${input.stylePrefix} in ${input.shop} since ${input.since}`);
  }
  return parsedResponse.data.row;
}

export const styleSummaryDescriptor: ToolDescriptor<StyleSummaryInput, StyleSummaryRow> = {
  id: "lingxing.styleSummary",
  cliSubcommand: "style-summary",
  source: "lingxing",
  description:
    "Aggregate Lingxing sales and returns by seller SKU style prefix for a shop since YYYY-MM-DD. " +
    "Use for questions like 'EE02559 return rate last 30 days' where the user gives a style code, not an ASIN.",
  readOnly: true,
  inputSchema: styleSummaryInputSchema,
  outputSchema: styleSummaryRowSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler: handleStyleSummary,
};

export async function styleSummary(ctx: ExecutionContext, input: unknown): Promise<StyleSummaryRow> {
  return runTool(ctx, async () => handleStyleSummary(ctx, parseStyleSummaryInput(input)));
}
