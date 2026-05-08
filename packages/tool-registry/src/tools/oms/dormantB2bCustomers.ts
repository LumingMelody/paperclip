import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryOms } from "./client.js";

const inputSchema = z
  .object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD").optional(),
    dormancyDays: z.coerce.number().int().min(1).max(3650).optional(),
    includeDisabled: z.coerce.boolean().optional(),
    top: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const rowSchema = z.object({
  customerEmail: z.string(),
  customerName: z.string().nullable(),
  customerState: z.string().nullable(),
  orderCount: z.number(),
  totalGmv: z.number(),
  avgOrderValue: z.number(),
  currency: z.string().nullable(),
  firstOrderDate: z.string().nullable(),
  lastOrderDate: z.string().nullable(),
  daysSinceLastOrder: z.number().nullable(),
  paidCount: z.number(),
  refundedCount: z.number(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type OmsDormantB2bCustomersInput = z.infer<typeof inputSchema>;
export type OmsDormantB2bCustomersOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: OmsDormantB2bCustomersInput): Promise<OmsDormantB2bCustomersOutput> {
  const result = await queryOms(ctx.companyId, {
    op: "dormantB2bCustomers",
    since: input.since,
    until: input.until,
    dormancyDays: input.dormancyDays ?? 30,
    includeDisabled: input.includeDisabled ?? true,
    top: input.top ?? 30,
  });
  return outputSchema.parse(result);
}

export const dormantB2bCustomersDescriptor: ToolDescriptor<OmsDormantB2bCustomersInput, OmsDormantB2bCustomersOutput> = {
  id: "oms.dormantB2bCustomers",
  cliSubcommand: "dormant-b2b-customers",
  source: "oms",
  description:
    "Lapsed B2B (e4wholesale.com) wholesale customers — those who haven't ordered in " +
    "`dormancyDays` days (default 30) OR whose Shopify customer_state is 'disabled' " +
    "(toggle via `includeDisabled`). Sorted by daysSinceLastOrder DESC then totalGmv DESC " +
    "so highest-value lapsed customers appear first. Use to drive sales win-back outreach. " +
    "Same row shape as b2bCustomerRanking. Source: internal kdls-oms MySQL.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
