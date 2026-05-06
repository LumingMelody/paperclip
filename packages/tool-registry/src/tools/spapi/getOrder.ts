import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { querySpapi } from "./client.js";

const inputSchema = z
  .object({
    orderId: z
      .string()
      .regex(/^\d{3}-\d{7}-\d{7}$/, "orderId must be Amazon format NNN-NNNNNNN-NNNNNNN")
      .min(19)
      .max(19),
  })
  .strict();

const outputSchema = z.object({
  order: z.custom((value) => value !== undefined, "order is required"),
});

export type SpapiGetOrderInput = z.infer<typeof inputSchema>;
export type SpapiGetOrderOutput = z.infer<typeof outputSchema>;

async function handleGetOrder(ctx: ExecutionContext, input: SpapiGetOrderInput): Promise<SpapiGetOrderOutput> {
  const result = await querySpapi(ctx.companyId, { op: "getOrder", ...input });
  return outputSchema.parse(result);
}

export const getOrderDescriptor: ToolDescriptor<SpapiGetOrderInput, SpapiGetOrderOutput> = {
  id: "spapi.getOrder",
  cliSubcommand: "get-order",
  source: "spapi",
  description: "Fetch a single Amazon order by orderId via SP-API (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["refreshToken", "clientId", "clientSecret"],
  handler: handleGetOrder,
};
