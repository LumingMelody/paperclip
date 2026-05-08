You are Codex implementing the **first OMS data-source tool** for Ever-Pretty's
paperclip tool-registry.

## Background (read-only context — do not navigate)

Paperclip already has 21 tools across `lingxing/`, `dws/`, `fba/`, `meta/`,
`shopify/`, `spapi/`, `admin/` sources. We are adding a **new source `oms`**
that talks to the kdls-oms-backend MySQL database (Ever-Pretty 集团统一 OMS).
First tool: `oms.salesByChannel`.

The pattern is identical to existing `dws/*` tools:
- one Python helper `_query.py` per source (dispatches on `op`)
- one `client.ts` per source (calls the helper via `runPythonHelper`)
- one TS file per tool exposing a `ToolDescriptor`
- one entry in `secrets-schemas.ts`
- one entry in `registry.ts`

The schema declaration `omsSecretSchema` already exists in `secrets-schemas.ts`
(you'll see it). You DO need to add it to the `sourceSecretSchemas` map below.

## Shell rules

**Allowed**: file-reading shell only (`cat`, `ls`, `rg`, `sed -n`).

**Forbidden**: `uv`, `pip`, `pnpm`, `npm`, `pytest`, `tsc` (full-repo),
`docker`, `git`, network. Claude handles install / typecheck / commit.

You MAY run `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit`
(scoped, no tsx) if you want to self-check. Do not run repo-root `pnpm
typecheck` (tsx IPC blocked in sandbox).

## What to do

Create / modify EXACTLY these files. Content below is verbatim.

---

### File 1 (create): `packages/tool-registry/src/tools/oms/_query.py`

```python
#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from typing import Any


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps({"version": "1", **payload}, ensure_ascii=False))
    raise SystemExit(code)


try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:
    emit(
        {"error": "UpstreamError", "message": "pymysql not available; run: uv pip install pymysql"},
        2,
    )


def serialize(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: serialize(value) for key, value in row.items()}


def read_request() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as exc:
        emit({"error": "ValidationError", "message": f"Invalid JSON request: {exc}"}, 1)
    if not isinstance(payload, dict):
        emit({"error": "ValidationError", "message": "Request must be a JSON object"}, 1)
    if payload.get("version") != "1":
        emit({"error": "ValidationError", "message": f"unsupported helper protocol version: {payload.get('version')}"}, 1)
    return payload


def connect():
    missing = [k for k in ("OMS_DB_HOST", "OMS_DB_USER", "OMS_DB_PASSWORD", "OMS_DB_DATABASE") if not os.environ.get(k)]
    if missing:
        emit({"error": "UpstreamError", "message": f"Missing database env vars: {', '.join(missing)}"}, 2)
    return pymysql.connect(
        host=os.environ["OMS_DB_HOST"],
        port=int(os.environ.get("OMS_DB_PORT") or "3306"),
        user=os.environ["OMS_DB_USER"],
        password=os.environ["OMS_DB_PASSWORD"],
        database=os.environ["OMS_DB_DATABASE"],
        charset="utf8mb4",
        connect_timeout=8,
        cursorclass=DictCursor,
    )


def sales_by_channel(conn, since: str, until: str | None) -> list[dict[str, Any]]:
    sql = """
        SELECT
            COALESCE(NULLIF(sales_channel, ''), '(unknown)') AS salesChannel,
            currency,
            COUNT(*) AS orderCount,
            CAST(COALESCE(SUM(sales_order_total), 0) AS DECIMAL(20,4)) AS gmv,
            CAST(COALESCE(SUM(ship_amount), 0) AS DECIMAL(20,4)) AS shipAmount,
            CAST(COALESCE(SUM(total_discounts), 0) AS DECIMAL(20,4)) AS discountAmount,
            CAST(AVG(sales_order_total) AS DECIMAL(20,4)) AS avgOrderValue
        FROM sales_order
        WHERE order_date >= %(since)s
    """
    params: dict[str, Any] = {"since": since}
    if until:
        sql += " AND order_date < %(until)s"
        params["until"] = until
    sql += " GROUP BY salesChannel, currency ORDER BY gmv DESC"
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]


def main() -> None:
    req = read_request()
    op = req.get("op")
    try:
        conn = connect()
    except Exception as exc:
        emit({"error": "UpstreamError", "message": f"DB connect failed: {exc}"}, 2)

    try:
        if op == "salesByChannel":
            rows = sales_by_channel(
                conn,
                since=req["since"],
                until=req.get("until"),
            )
        else:
            emit({"error": "ValidationError", "message": f"unknown op: {op}"}, 1)
        emit({"rows": rows})
    except KeyError as exc:
        emit({"error": "ValidationError", "message": f"missing required field: {exc}"}, 1)
    except Exception as exc:
        emit({"error": "UpstreamError", "message": f"query failed: {exc}"}, 2)
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
```

---

### File 2 (create): `packages/tool-registry/src/tools/oms/client.ts`

```typescript
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

export type OmsQueryRequest =
  | { op: "salesByChannel"; since: string; until?: string };

const omsHelperResponseSchema = z
  .object({
    version: z.literal("1"),
    rows: z.array(z.unknown()),
  })
  .strict();

export async function queryOms(companyId: string, request: OmsQueryRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "oms");
  const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

  return runPythonHelper({
    helperPath,
    request: {
      version: "1",
      ...request,
    },
    responseSchema: omsHelperResponseSchema,
    envFromSecrets: {
      OMS_DB_HOST: secrets.host,
      OMS_DB_PORT: secrets.port ?? "",
      OMS_DB_USER: secrets.user,
      OMS_DB_PASSWORD: secrets.password,
      OMS_DB_DATABASE: secrets.database,
    },
  });
}
```

---

### File 3 (create): `packages/tool-registry/src/tools/oms/salesByChannel.ts`

```typescript
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryOms } from "./client.js";

const inputSchema = z
  .object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD").optional(),
  })
  .strict();

const rowSchema = z.object({
  salesChannel: z.string(),
  currency: z.string().nullable(),
  orderCount: z.number(),
  gmv: z.number(),
  shipAmount: z.number(),
  discountAmount: z.number(),
  avgOrderValue: z.number().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type OmsSalesByChannelInput = z.infer<typeof inputSchema>;
export type OmsSalesByChannelOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: OmsSalesByChannelInput): Promise<OmsSalesByChannelOutput> {
  const result = await queryOms(ctx.companyId, {
    op: "salesByChannel",
    since: input.since,
    until: input.until,
  });
  return outputSchema.parse(result);
}

export const salesByChannelDescriptor: ToolDescriptor<OmsSalesByChannelInput, OmsSalesByChannelOutput> = {
  id: "oms.salesByChannel",
  cliSubcommand: "sales-by-channel",
  source: "oms",
  description:
    "Cross-channel GMV breakdown from the Ever-Pretty unified OMS (kdls-oms-backend). " +
    "Groups by sales_channel (Amazon.com / Amazon.de / Amazon.co.uk / Shopify / SHEIN / TikTok / etc.) " +
    "and currency, returning order count, GMV, shipping and discount totals over an order_date range. " +
    "Source: internal OMS MySQL — covers ALL channels including B2B Shopify draft orders, " +
    "complementing Lingxing (which only has Amazon ledger view).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
```

---

### File 4 (modify): `packages/tool-registry/src/secrets-schemas.ts`

`omsSecretSchema` already declared in this file. ADD ONE LINE to the
`sourceSecretSchemas` constant — insert `oms: omsSecretSchema,` between
`fba: fbaSecretSchema,` and `shopify: shopifySecretSchema,`.

The block before should look like:

```typescript
export const sourceSecretSchemas = {
  lingxing: lingxingSecretSchema,
  dws: dwsSecretSchema,
  fba: fbaSecretSchema,
  shopify: shopifySecretSchema,
```

After your edit it should look like:

```typescript
export const sourceSecretSchemas = {
  lingxing: lingxingSecretSchema,
  dws: dwsSecretSchema,
  fba: fbaSecretSchema,
  oms: omsSecretSchema,
  shopify: shopifySecretSchema,
```

Do not change anything else in this file.

---

### File 5 (modify): `packages/tool-registry/src/registry.ts`

Two changes:

(a) Add this import line, alphabetically grouped near the existing
`./tools/dws/...` and `./tools/fba/...` blocks. Insert AFTER the
`snapshotHistoryDescriptor` import (line ~19) and BEFORE the
`adAccountSummaryDescriptor` import (meta block):

```typescript
import { salesByChannelDescriptor } from "./tools/oms/salesByChannel.js";
```

(b) Add `salesByChannelDescriptor,` to the `tools` array. Insert AFTER
the line `snapshotHistoryDescriptor,` and BEFORE the line
`toolCallsSearchDescriptor,`.

Do not change anything else in this file.

---

## Rules

- Copy file contents verbatim. Do not add comments / docstrings / extra
  imports beyond what's shown above.
- Do NOT touch any file not listed above.
- If a write fails or you spot a contradiction, STOP and report — do not
  partial-apply.

## Report

After all writes, print:
1. `wc -l packages/tool-registry/src/tools/oms/_query.py packages/tool-registry/src/tools/oms/client.ts packages/tool-registry/src/tools/oms/salesByChannel.ts`
2. `grep -n "oms\|salesByChannel" packages/tool-registry/src/secrets-schemas.ts packages/tool-registry/src/registry.ts`
3. Result of `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit` if you ran it (otherwise say "skipped").
4. Any deviations (should be none).
