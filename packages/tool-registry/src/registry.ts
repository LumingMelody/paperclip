import type { ExecutionContext } from "./context.js";
import type { ZodSchema } from "zod";
import { decisionsSearchDescriptor } from "./tools/admin/decisionsSearch.js";
import { factOrdersDescriptor } from "./tools/lingxing/factOrders.js";
import { factSkuDescriptor } from "./tools/lingxing/factSku.js";
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
  toolCallsSearchDescriptor,
  getProductDescriptor,
  listProductsByCollectionDescriptor,
  adAccountSummaryDescriptor,
  adsetPerformanceDescriptor,
  getOrderDescriptor,
  listOrdersUpdatedSinceDescriptor,
  decisionsSearchDescriptor,
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
