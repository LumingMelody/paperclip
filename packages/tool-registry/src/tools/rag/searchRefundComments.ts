import { z, type ZodSchema } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { UpstreamError } from "../../errors.js";
import { ragSearch, RagUnavailable } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;

const inputSchema = z
  .object({
    shop: z
      .string()
      .regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc.")
      .optional(),
    query: z.string().min(1).max(500),
    topK: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const metaSchema = z
  .object({
    translation: z.enum(["passthrough", "translated", "fallback"]).nullable().optional(),
    originalQuery: z.string().nullable().optional(),
    translatedQuery: z.string().nullable().optional(),
    translateMs: z.number().nullable().optional(),
    fallbackReason: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const referenceSchema = z.object({
  reference_id: z.string(),
  file_path: z.string(),
});

const outputSchema = z.object({
  answer: z.string(),
  references: z.array(referenceSchema).default([]),
  meta: metaSchema,
});

export type RagSearchRefundCommentsInput = z.infer<typeof inputSchema>;
export type RagSearchRefundCommentsOutput = z.infer<typeof outputSchema>;

/** Render `EP-UK/EE02968/302-111-222` as `EP-UK / EE02968 / 302-111-222`. */
function formatReference(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length === 3 ? parts.join(" / ") : filePath;
}

/** Append a human-readable source list so the DingTalk bot shows it verbatim. */
function appendReferences(
  answer: string,
  references: z.infer<typeof referenceSchema>[],
): string {
  if (references.length === 0) return answer;
  const lines = references
    .slice(0, 8)
    .map((r) => `- ${formatReference(r.file_path)}`);
  const header =
    references.length > lines.length
      ? `**来源**（共 ${references.length} 条客户评论，显示前 ${lines.length} 条）`
      : `**来源**（${references.length} 条客户评论）`;
  return `${answer}\n\n---\n${header}：\n${lines.join("\n")}`;
}

async function handler(
  _ctx: ExecutionContext,
  input: RagSearchRefundCommentsInput,
): Promise<RagSearchRefundCommentsOutput> {
  const query = input.shop ? `（限定店铺：${input.shop}）${input.query}` : input.query;
  try {
    const r = await ragSearch({
      collection: "refund_comments",
      query,
      topK: input.topK,
    });
    const parsed = outputSchema.parse(r);
    return {
      ...parsed,
      answer: appendReferences(parsed.answer, parsed.references),
    };
  } catch (e) {
    if (e instanceof RagUnavailable) {
      throw new UpstreamError(`rag service unavailable: ${e.message}`);
    }
    throw e;
  }
}

export const searchRefundCommentsDescriptor: ToolDescriptor<
  RagSearchRefundCommentsInput,
  RagSearchRefundCommentsOutput
> = {
  id: "rag.searchRefundComments",
  cliSubcommand: "search-refund-comments",
  source: "rag",
  description:
    "Semantic search over ingested customer refund comments, augmented by an " +
    "entity knowledge graph (SKU / styleCode / returnReason / size / color). " +
    "Returns a synthesized Chinese answer based on retrieved customer-comment " +
    "evidence, with a source list appended. " +
    "USE FOR: open-ended 'why are customers complaining' / 'what's the real " +
    "issue behind this return-reason code' / 'main complaints for SKU X' " +
    "semantic questions. CN and EN queries both work natively via the " +
    "multilingual bge-m3 embedding (no translation step). " +
    "DO NOT USE FOR: structured filtering (specific orderId, exact SKU+date " +
    "lookups, quantity thresholds) — use dws.refundComments instead. " +
    "ON ERROR: any error class (typically 'UpstreamError' when the RAG " +
    "service is down) means you should retry with dws.refundComments + a " +
    "CN keyword LIKE filter, and note '⚠️ RAG 暂不可用' in the reply. " +
    "SHOP: optional — pass a shop (EP-US, EP-UK, ...) to scope the answer to " +
    "one market; omit it to search across all ingested EP markets. " +
    "CURRENT INGEST: all EP Amazon markets. PZ / DAMA shops pass schema " +
    "validation but are not yet ingested — they return empty/poor results.",
  readOnly: true,
  inputSchema,
  outputSchema: outputSchema as ZodSchema<RagSearchRefundCommentsOutput>,
  requiredSecrets: [],
  handler,
};
