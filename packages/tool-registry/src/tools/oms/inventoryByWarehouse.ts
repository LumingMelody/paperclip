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
