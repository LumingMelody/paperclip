You are Codex implementing **`oms.inventoryByWarehouse`**, the fourth
OMS tool — cross-warehouse inventory visibility (the OMS data is more granular
than Lingxing — 27 warehouses including all FBA + 海外仓 + 国内主仓).

## Pattern reference

Same OMS pattern; this is now the **fourth** tool on this source. By the time
you run, `dormantB2bCustomers` should already exist; do not delete or modify it.

Files:
- `packages/tool-registry/src/tools/oms/_query.py` — add op `inventoryByWarehouse`
- `packages/tool-registry/src/tools/oms/client.ts` — extend union
- `packages/tool-registry/src/tools/oms/inventoryByWarehouse.ts` — NEW
- `packages/tool-registry/src/registry.ts` — import + array entry

## Schema reference

Tables:
- `inventory` — has `warehouse_id`, `sku_code`, `physical_quantity`,
  `available_quantity`, `frozen_quantity`, `transit_in_quantity`,
  `transit_out_quantity`, `last_sync_time`, `deleted` (filter `deleted = 0`)
- `warehouses` — has `id`, `warehouse_code`, `warehouse_name`,
  `warehouse_type` (enum: MAIN/BRANCH/TEMPORARY/THIRD_PARTY/FBA),
  `country_code`, `is_active`

Join: `inventory.warehouse_id = warehouses.id`.

## Shell rules

**Allowed**: `cat`, `ls`, `rg`, `sed -n`.
**Forbidden**: same as before. You MAY run `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit`.

## What to do

### Change 1 (modify): `packages/tool-registry/src/tools/oms/_query.py`

Insert this function right BEFORE `def main()`. Don't touch anything else.

```python
def inventory_by_warehouse(
    conn,
    sku: str | None,
    warehouse_code: str | None,
    country: str | None,
    warehouse_type: str | None,
    min_available: int,
    top: int,
) -> list[dict[str, Any]]:
    sql = """
        SELECT
            i.sku_code AS sku,
            w.warehouse_code AS warehouseCode,
            w.warehouse_name AS warehouseName,
            w.warehouse_type AS warehouseType,
            w.country_code AS countryCode,
            i.physical_quantity AS physicalQuantity,
            i.available_quantity AS availableQuantity,
            i.frozen_quantity AS frozenQuantity,
            i.transit_in_quantity AS transitInQuantity,
            i.transit_out_quantity AS transitOutQuantity,
            i.defective_quantity AS defectiveQuantity,
            i.last_sync_time AS lastSyncTime
        FROM inventory i
        JOIN warehouses w ON i.warehouse_id = w.id
        WHERE i.deleted = 0
          AND w.is_active = 1
          AND i.available_quantity >= %(min_available)s
    """
    params: dict[str, Any] = {"min_available": min_available}
    if sku:
        sql += " AND i.sku_code = %(sku)s"
        params["sku"] = sku
    if warehouse_code:
        sql += " AND w.warehouse_code = %(warehouse_code)s"
        params["warehouse_code"] = warehouse_code
    if country:
        sql += " AND w.country_code = %(country)s"
        params["country"] = country
    if warehouse_type:
        sql += " AND w.warehouse_type = %(warehouse_type)s"
        params["warehouse_type"] = warehouse_type
    sql += " ORDER BY i.available_quantity DESC LIMIT %(top)s"
    params["top"] = top
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION READ ONLY")
        cur.execute(sql, params)
        return [serialize_row(r) for r in cur.fetchall()]
```

Inside `main()`, add this elif branch after the existing OMS branches and
before the `else: emit({"error": ...})`:

```python
        elif op == "inventoryByWarehouse":
            rows = inventory_by_warehouse(
                conn,
                sku=req.get("sku"),
                warehouse_code=req.get("warehouseCode"),
                country=req.get("country"),
                warehouse_type=req.get("warehouseType"),
                min_available=int(req.get("minAvailable", 0)),
                top=int(req.get("top", 50)),
            )
```

### Change 2 (modify): `packages/tool-registry/src/tools/oms/client.ts`

Replace the existing `OmsQueryRequest` union (which already has 3 variants)
by adding a 4th. Find the exact final `;` of the current union and extend it
so it reads:

```typescript
export type OmsQueryRequest =
  | { op: "salesByChannel"; since: string; until?: string }
  | { op: "b2bCustomerRanking"; since: string; until?: string; top?: number }
  | { op: "dormantB2bCustomers"; since: string; until?: string; dormancyDays?: number; includeDisabled?: boolean; top?: number }
  | { op: "inventoryByWarehouse"; sku?: string; warehouseCode?: string; country?: string; warehouseType?: string; minAvailable?: number; top?: number };
```

Don't change anything else.

### Change 3 (create): `packages/tool-registry/src/tools/oms/inventoryByWarehouse.ts`

```typescript
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { queryOms } from "./client.js";

const inputSchema = z
  .object({
    sku: z.string().min(1).optional(),
    warehouseCode: z.string().min(1).optional(),
    country: z.string().regex(/^[A-Z]{2}$/, "country must be 2-letter ISO code").optional(),
    warehouseType: z.enum(["MAIN", "BRANCH", "TEMPORARY", "THIRD_PARTY", "FBA"]).optional(),
    minAvailable: z.coerce.number().int().min(0).optional(),
    top: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const rowSchema = z.object({
  sku: z.string().nullable(),
  warehouseCode: z.string(),
  warehouseName: z.string().nullable(),
  warehouseType: z.string().nullable(),
  countryCode: z.string().nullable(),
  physicalQuantity: z.number(),
  availableQuantity: z.number(),
  frozenQuantity: z.number(),
  transitInQuantity: z.number(),
  transitOutQuantity: z.number(),
  defectiveQuantity: z.number(),
  lastSyncTime: z.string().nullable(),
});

const outputSchema = z.object({ rows: z.array(rowSchema) });

export type OmsInventoryByWarehouseInput = z.infer<typeof inputSchema>;
export type OmsInventoryByWarehouseOutput = z.infer<typeof outputSchema>;

async function handler(ctx: ExecutionContext, input: OmsInventoryByWarehouseInput): Promise<OmsInventoryByWarehouseOutput> {
  const result = await queryOms(ctx.companyId, {
    op: "inventoryByWarehouse",
    sku: input.sku,
    warehouseCode: input.warehouseCode,
    country: input.country,
    warehouseType: input.warehouseType,
    minAvailable: input.minAvailable ?? 0,
    top: input.top ?? 50,
  });
  return outputSchema.parse(result);
}

export const inventoryByWarehouseDescriptor: ToolDescriptor<OmsInventoryByWarehouseInput, OmsInventoryByWarehouseOutput> = {
  id: "oms.inventoryByWarehouse",
  cliSubcommand: "inventory-by-warehouse",
  source: "oms",
  description:
    "Cross-warehouse inventory snapshot from the unified OMS (kdls-oms-backend). " +
    "Covers all 27 active warehouses: 国内主仓 (BY/CN/SZ/DAREN), 海外仓 (UK 万洲国际/法国天马/德国/意大利), " +
    "FBA (FBA_EP_US/UK/DE/FR/IT, FBA_PZ_*, FBA_DAMA_USFBA, FBA_AS_US, AmazonEYUS), 易可达谷仓 (USCE/USSC/USE), " +
    "SHEIN 仓. Per row: physical / available / frozen / transit-in / transit-out / defective " +
    "quantities + last_sync_time. Optional filters: sku, warehouseCode, country (ISO-2), " +
    "warehouseType (MAIN/FBA/etc), minAvailable. Sorted by available DESC. " +
    "Far more granular than Lingxing FBA — answers 'where is SKU X stocked', " +
    "'which warehouses are low', 'how much in-transit to FBA_EP_UK'. Source: internal kdls-oms MySQL.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["host", "user", "password", "database"],
  handler,
};
```

### Change 4 (modify): `packages/tool-registry/src/registry.ts`

(a) Add this import line directly BELOW the existing
`import { dormantB2bCustomersDescriptor } from "./tools/oms/dormantB2bCustomers.js";`
line:

```typescript
import { inventoryByWarehouseDescriptor } from "./tools/oms/inventoryByWarehouse.js";
```

(b) In the `tools` array, add `inventoryByWarehouseDescriptor,` immediately
AFTER the existing `dormantB2bCustomersDescriptor,` line.

Don't change anything else.

---

## Rules

- Copy verbatim.
- Don't touch any file not listed.
- Stop and report on contradiction.

## Report

After all writes:
1. `wc -l packages/tool-registry/src/tools/oms/inventoryByWarehouse.ts`
2. `grep -n "inventoryByWarehouse\|inventory_by_warehouse" packages/tool-registry/src/tools/oms/_query.py packages/tool-registry/src/tools/oms/client.ts packages/tool-registry/src/registry.ts`
3. Result of `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit`.
4. Any deviations (should be none).
