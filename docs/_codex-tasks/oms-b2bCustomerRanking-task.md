You are Codex implementing the **second OMS tool** for Ever-Pretty's
paperclip tool-registry: `oms.b2bCustomerRanking`.

## Background (read-only context — do not navigate)

- The first OMS tool `oms.salesByChannel` was committed in this same package.
  Use it as the implementation pattern reference:
  - `packages/tool-registry/src/tools/oms/_query.py` — already has `connect()`,
    `serialize_row()`, `read_request()`, `emit()`, and a `salesByChannel` op.
    Add a NEW op `b2bCustomerRanking` alongside it.
  - `packages/tool-registry/src/tools/oms/client.ts` — already has
    `OmsQueryRequest` union and `queryOms()`. Extend the union with the new op.
  - `packages/tool-registry/src/tools/oms/salesByChannel.ts` — copy this file's
    structure to make `b2bCustomerRanking.ts`.

- Business context: Ever-Pretty group's B2B brand `e4wholesale.com` writes
  orders into `shopify_order` table with `name LIKE 'E4WHOLESALE%'`
  (account_id=95). 252 historical orders, $85k GMV, 60 distinct customers,
  AOV $339 (~3x B2C). The valuable analytic view is **customer ranking**
  (Top buyers, dormancy, repeat behavior).

## Shell rules

**Allowed**: file-reading shell only (`cat`, `ls`, `rg`, `sed -n`).

**Forbidden**: `uv`, `pip`, `pnpm`, `npm`, `pytest`, `tsc` (full-repo),
`docker`, `git`, network. Claude handles install / typecheck / commit.

You MAY run `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit`
(scoped, no tsx) for self-check.

## What to do

### Change 1 (modify): `packages/tool-registry/src/tools/oms/_query.py`

Add a new function `b2b_customer_ranking()` BEFORE the `main()` function,
and add a new `op` branch inside `main()`. Do NOT delete or change the
existing `sales_by_channel` function or any imports.

**New function** (insert after `sales_by_channel` ends, before `def main()`):

```python
def b2b_customer_ranking(conn, since: str, until: str | None, top: int) -> list[dict[str, Any]]:
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
        ORDER BY totalGmv DESC
        LIMIT %(top)s
    """
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]
```

**Inside `main()`**: locate the `if op == "salesByChannel":` block and add an
`elif` branch BEFORE the `else:` that says `unknown op`:

```python
        elif op == "b2bCustomerRanking":
            rows = b2b_customer_ranking(
                conn,
                since=req["since"],
                until=req.get("until"),
                top=int(req.get("top", 20)),
            )
```

Do not change anything else in `_query.py`.

### Change 2 (modify): `packages/tool-registry/src/tools/oms/client.ts`

Extend the `OmsQueryRequest` union type to include the new op. Replace this
exact line:

```typescript
export type OmsQueryRequest =
  | { op: "salesByChannel"; since: string; until?: string };
```

With:

```typescript
export type OmsQueryRequest =
  | { op: "salesByChannel"; since: string; until?: string }
  | { op: "b2bCustomerRanking"; since: string; until?: string; top?: number };
```

Do not change anything else.

### Change 3 (create): `packages/tool-registry/src/tools/oms/b2bCustomerRanking.ts`

```typescript
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryOms } from "./client.js";

const inputSchema = z
  .object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD").optional(),
    top: z.coerce.number().int().min(1).max(100).optional(),
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

export type OmsB2bCustomerRankingInput = z.infer<typeof inputSchema>;
export type OmsB2bCustomerRankingOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: OmsB2bCustomerRankingInput): Promise<OmsB2bCustomerRankingOutput> {
  const result = await queryOms(ctx.companyId, {
    op: "b2bCustomerRanking",
    since: input.since,
    until: input.until,
    top: input.top ?? 20,
  });
  return outputSchema.parse(result);
}

export const b2bCustomerRankingDescriptor: ToolDescriptor<OmsB2bCustomerRankingInput, OmsB2bCustomerRankingOutput> = {
  id: "oms.b2bCustomerRanking",
  cliSubcommand: "b2b-customer-ranking",
  source: "oms",
  description:
    "Top B2B (e4wholesale.com) customers ranked by GMV over a date range. " +
    "Identifies wholesale customers via name LIKE 'E4WHOLESALE%' in the unified OMS. " +
    "Returns per-customer order count, GMV, AOV, currency, first/last order dates, " +
    "days-since-last-order (dormancy signal), and paid/refunded counts. " +
    "Use to answer: 'who are our top wholesale buyers', 'which B2B customers stopped " +
    "ordering recently', 'B2B repeat-buyer concentration'. Source: internal kdls-oms " +
    "MySQL — no equivalent in Lingxing/DWS (those are Amazon-centric).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
```

### Change 4 (modify): `packages/tool-registry/src/registry.ts`

(a) Add this import line, right BELOW the existing
`import { salesByChannelDescriptor } from "./tools/oms/salesByChannel.js";`
line:

```typescript
import { b2bCustomerRankingDescriptor } from "./tools/oms/b2bCustomerRanking.js";
```

(b) In the `tools` array, add `b2bCustomerRankingDescriptor,` immediately
AFTER the existing `salesByChannelDescriptor,` line.

Do not change anything else in this file.

---

## Rules

- Copy code verbatim. No extra comments / docstrings / refactors.
- Do NOT touch any file not listed above.
- If a write fails or you spot a contradiction, STOP and report.

## Report

After all writes:
1. `wc -l packages/tool-registry/src/tools/oms/b2bCustomerRanking.ts`
2. `grep -n "b2bCustomerRanking\|b2b_customer_ranking" packages/tool-registry/src/tools/oms/_query.py packages/tool-registry/src/tools/oms/client.ts packages/tool-registry/src/registry.ts`
3. Result of `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit` if you ran it.
4. Any deviations (should be none).
