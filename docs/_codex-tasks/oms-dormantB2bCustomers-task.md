You are Codex implementing **`oms.dormantB2bCustomers`**, the third
OMS tool — a dormancy-flagging variant of `oms.b2bCustomerRanking`.

## Pattern reference

The OMS source already exists; just follow the dws-style append pattern:
- `packages/tool-registry/src/tools/oms/_query.py` — add new op `dormantB2bCustomers` next to `b2bCustomerRanking`
- `packages/tool-registry/src/tools/oms/client.ts` — extend `OmsQueryRequest` union
- `packages/tool-registry/src/tools/oms/dormantB2bCustomers.ts` — NEW (mirror `b2bCustomerRanking.ts`)
- `packages/tool-registry/src/registry.ts` — import + array entry

## Business intent

Wholesale customers stop ordering for many reasons: switched supplier, business
closed, seasonal, dispute. The earlier we surface them the higher the recovery
chance. Filter B2B customers (name LIKE 'E4WHOLESALE%') by either:
- `daysSinceLastOrder >= dormancyDays` (default 30), AND/OR
- `customer_state = 'disabled'` (Shopify disabled the account)

Sort dormant-first then by lifetime GMV (highest-value lapsed customers at top).

## Shell rules

**Allowed**: `cat`, `ls`, `rg`, `sed -n`.
**Forbidden**: `uv`, `pip`, `pnpm`, `npm`, `pytest`, full-repo `tsc`, `docker`, `git`, network. Claude handles install / typecheck / commit.
You MAY run `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit` (scoped).

## What to do

### Change 1 (modify): `packages/tool-registry/src/tools/oms/_query.py`

Insert this function right BEFORE `def main()`. Do NOT remove anything.

```python
def dormant_b2b_customers(
    conn,
    since: str,
    until: str | None,
    dormancy_days: int,
    include_disabled: bool,
    top: int,
) -> list[dict[str, Any]]:
    sql = """
        SELECT
            COALESCE(NULLIF(customer_email, ''), '(unknown)') AS customerEmail,
            MAX(NULLIF(CONCAT_WS(' ', customer_first_name, customer_last_name), ' ')) AS customerName,
            MAX(customer_state) AS customerState,
            COUNT(*) AS orderCount,
            CAST(COALESCE(SUM(total_price), 0) AS DECIMAL(20,4)) AS totalGmv,
            CAST(COALESCE(AVG(total_price), 0) AS DECIMAL(20,4)) AS avgOrderValue,
            MAX(currency) AS currency,
            MIN(order_created_at) AS firstOrderDate,
            MAX(order_created_at) AS lastOrderDate,
            DATEDIFF(CURRENT_DATE, MAX(order_created_at)) AS daysSinceLastOrder,
            SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) AS paidCount,
            SUM(CASE WHEN financial_status IN ('refunded', 'partially_refunded') THEN 1 ELSE 0 END) AS refundedCount
        FROM shopify_order
        WHERE name LIKE 'E4WHOLESALE%%'
          AND order_created_at >= %(since)s
    """
    params: dict[str, Any] = {"since": since}
    if until:
        sql += " AND order_created_at < %(until)s"
        params["until"] = until
    sql += """
        GROUP BY customerEmail
        HAVING customerEmail != '(unknown)'
    """
    if include_disabled:
        sql += """
           AND (
               DATEDIFF(CURRENT_DATE, MAX(order_created_at)) >= %(dormancy_days)s
               OR MAX(customer_state) = 'disabled'
           )
        """
    else:
        sql += """
           AND DATEDIFF(CURRENT_DATE, MAX(order_created_at)) >= %(dormancy_days)s
        """
    sql += """
        ORDER BY daysSinceLastOrder DESC, totalGmv DESC
        LIMIT %(top)s
    """
    params["dormancy_days"] = dormancy_days
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]
```

Inside `main()`, locate `elif op == "b2bCustomerRanking":` and add an additional
elif branch immediately after it (before the `else: emit({"error": ...})`):

```python
        elif op == "dormantB2bCustomers":
            rows = dormant_b2b_customers(
                conn,
                since=req["since"],
                until=req.get("until"),
                dormancy_days=int(req.get("dormancyDays", 30)),
                include_disabled=bool(req.get("includeDisabled", True)),
                top=int(req.get("top", 30)),
            )
```

### Change 2 (modify): `packages/tool-registry/src/tools/oms/client.ts`

Extend the union. Replace this exact block:

```typescript
export type OmsQueryRequest =
  | { op: "salesByChannel"; since: string; until?: string }
  | { op: "b2bCustomerRanking"; since: string; until?: string; top?: number };
```

With:

```typescript
export type OmsQueryRequest =
  | { op: "salesByChannel"; since: string; until?: string }
  | { op: "b2bCustomerRanking"; since: string; until?: string; top?: number }
  | { op: "dormantB2bCustomers"; since: string; until?: string; dormancyDays?: number; includeDisabled?: boolean; top?: number };
```

### Change 3 (create): `packages/tool-registry/src/tools/oms/dormantB2bCustomers.ts`

```typescript
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
```

### Change 4 (modify): `packages/tool-registry/src/registry.ts`

(a) Add this import line directly BELOW the existing
`import { b2bCustomerRankingDescriptor } from "./tools/oms/b2bCustomerRanking.js";`
line:

```typescript
import { dormantB2bCustomersDescriptor } from "./tools/oms/dormantB2bCustomers.js";
```

(b) In the `tools` array, add `dormantB2bCustomersDescriptor,` immediately
AFTER the existing `b2bCustomerRankingDescriptor,` line.

Do not change anything else in this file.

---

## Rules

- Copy verbatim.
- Don't touch any file not listed.
- Stop and report on contradiction.

## Report

After all writes:
1. `wc -l packages/tool-registry/src/tools/oms/dormantB2bCustomers.ts`
2. `grep -n "dormantB2bCustomers\|dormant_b2b_customers" packages/tool-registry/src/tools/oms/_query.py packages/tool-registry/src/tools/oms/client.ts packages/tool-registry/src/registry.ts`
3. Result of `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit`.
4. Any deviations (should be none).
