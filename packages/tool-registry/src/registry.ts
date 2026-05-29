import type { ExecutionContext } from "./context.js";
import type { ZodSchema } from "zod";
import { briefParseDescriptor } from "./tools/admin/briefParse.js";
import { costsRollupDescriptor } from "./tools/admin/costsRollup.js";
import { decisionsSearchDescriptor } from "./tools/admin/decisionsSearch.js";
import { registryListDescriptor } from "./tools/admin/registryList.js";
import { factOrdersDescriptor } from "./tools/lingxing/factOrders.js";
import { factSkuDescriptor } from "./tools/lingxing/factSku.js";
import { styleSummaryDescriptor } from "./tools/lingxing/styleSummary.js";
import { stockoutRiskDescriptor } from "./tools/lingxing/stockoutRisk.js";
import { topSkusDescriptor } from "./tools/lingxing/topSkus.js";
import { returnReasonsDescriptor } from "./tools/dws/returnReasons.js";
import { returnRateByStyleDescriptor } from "./tools/dws/returnRateByStyle.js";
import { siteTopStylesDescriptor } from "./tools/dws/siteTopStyles.js";
import { returnsBySkuDescriptor } from "./tools/dws/returnsBySku.js";
import { returnDetailDescriptor } from "./tools/dws/returnDetail.js";
import { refundCommentsDescriptor } from "./tools/dws/refundComments.js";
import { returnTrendDescriptor } from "./tools/dws/returnTrend.js";
import { skusByReasonDescriptor } from "./tools/dws/skusByReason.js";
import { searchRefundCommentsDescriptor } from "./tools/rag/searchRefundComments.js";
import { currentInventoryDescriptor } from "./tools/fba/currentInventory.js";
import { lowStockDescriptor } from "./tools/fba/lowStock.js";
import { snapshotHistoryDescriptor } from "./tools/fba/snapshotHistory.js";
import { salesByChannelDescriptor } from "./tools/oms/salesByChannel.js";
import { b2bCustomerRankingDescriptor } from "./tools/oms/b2bCustomerRanking.js";
import { dormantB2bCustomersDescriptor } from "./tools/oms/dormantB2bCustomers.js";
import { inventoryByWarehouseDescriptor } from "./tools/oms/inventoryByWarehouse.js";
import { adAccountSummaryDescriptor } from "./tools/meta/adAccountSummary.js";
import { adsetPerformanceDescriptor } from "./tools/meta/adsetPerformance.js";
import { toolCallsSearchDescriptor } from "./tools/meta/toolCallsSearch.js";
import { getProductDescriptor } from "./tools/shopify/getProduct.js";
import { listProductsByCollectionDescriptor } from "./tools/shopify/listProductsByCollection.js";
import { getOrderDescriptor } from "./tools/spapi/getOrder.js";
import { listOrdersUpdatedSinceDescriptor } from "./tools/spapi/listOrdersUpdatedSince.js";

export interface ToolDescriptor<I = unknown, O = unknown> {
  id: string;
  cliSubcommand: string;
  source: string;
  description: string;
  readOnly: true;
  inputSchema: ZodSchema<I>;
  outputSchema?: ZodSchema<O>;
  requiredSecrets?: string[];
  handler(ctx: ExecutionContext, input: I): Promise<O>;
}

export const tools: ToolDescriptor[] = [
  factSkuDescriptor,
  factOrdersDescriptor,
  styleSummaryDescriptor,
  topSkusDescriptor,
  stockoutRiskDescriptor,
  returnReasonsDescriptor,
  returnRateByStyleDescriptor,
  siteTopStylesDescriptor,
  returnsBySkuDescriptor,
  returnDetailDescriptor,
  refundCommentsDescriptor,
  returnTrendDescriptor,
  skusByReasonDescriptor,
  currentInventoryDescriptor,
  lowStockDescriptor,
  snapshotHistoryDescriptor,
  salesByChannelDescriptor,
  b2bCustomerRankingDescriptor,
  dormantB2bCustomersDescriptor,
  inventoryByWarehouseDescriptor,
  toolCallsSearchDescriptor,
  getProductDescriptor,
  listProductsByCollectionDescriptor,
  adAccountSummaryDescriptor,
  adsetPerformanceDescriptor,
  getOrderDescriptor,
  listOrdersUpdatedSinceDescriptor,
  decisionsSearchDescriptor,
  registryListDescriptor,
  briefParseDescriptor,
  costsRollupDescriptor,
  searchRefundCommentsDescriptor,
];

export function registerTool(t: ToolDescriptor): void {
  tools.push(t);
}

function cliSourceName(source: string): string {
  return source.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();
}

export function findToolByCli(source: string, sub: string): ToolDescriptor | undefined {
  return tools.find((tool) => cliSourceName(tool.source) === source && tool.cliSubcommand === sub);
}

export function findToolById(id: string): ToolDescriptor | undefined {
  return tools.find((tool) => tool.id === id);
}
