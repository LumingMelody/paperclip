import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { querySpapi } from "./client.js";

const inputSchema = z
  .object({
    since: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
        "since must be ISO 8601 UTC (e.g. 2026-04-01T00:00:00Z)",
      ),
    marketplaceId: z
      .string()
      .regex(/^[A-Z0-9]+$/, "marketplaceId must be uppercase alphanumeric")
      .optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const outputSchema = z.object({
  orders: z.array(z.unknown()),
  nextToken: z.string().nullable().optional(),
});

export type SpapiListOrdersInput = z.infer<typeof inputSchema>;
export type SpapiListOrdersOutput = z.infer<typeof outputSchema>;

async function handleListOrders(
  ctx: ExecutionContext,
  input: SpapiListOrdersInput,
): Promise<SpapiListOrdersOutput> {
  const result = await querySpapi(ctx.companyId, { op: "listOrdersUpdatedSince", ...input });
  return outputSchema.parse(result);
}

export const listOrdersUpdatedSinceDescriptor: ToolDescriptor<
  SpapiListOrdersInput,
  SpapiListOrdersOutput
> = {
  id: "spapi.listOrdersUpdatedSince",
  cliSubcommand: "list-orders-updated-since",
  source: "spapi",
  description:
    "List Amazon orders updated after a timestamp via SP-API (read-only). Defaults marketplaceId from secrets if omitted.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["refreshToken", "clientId", "clientSecret"],
  handler: handleListOrders,
};
