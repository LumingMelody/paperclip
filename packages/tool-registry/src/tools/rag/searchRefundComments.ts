import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { UpstreamError } from "../../errors.js";
import { ragSearch, RagUnavailable } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;
const SUPPORTED_SHOPS = new Set(["EP-US"]);

const inputSchema = z
  .object({
    shop: z
      .string()
      .regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc.")
      .refine(
        (s) => SUPPORTED_SHOPS.has(s),
        (s) => ({
          message: `shop ${s} not yet ingested into RAG; supported: ${[...SUPPORTED_SHOPS].join(", ")}`,
        }),
      ),
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

const outputSchema = z.object({
  answer: z.string(),
  meta: metaSchema,
});

export type RagSearchRefundCommentsInput = z.infer<typeof inputSchema>;
export type RagSearchRefundCommentsOutput = z.infer<typeof outputSchema>;

async function handler(
  _ctx: ExecutionContext,
  input: RagSearchRefundCommentsInput,
): Promise<RagSearchRefundCommentsOutput> {
  try {
    const r = await ragSearch({
      collection: "refund_comments",
      query: input.query,
      topK: input.topK,
    });
    return outputSchema.parse(r);
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
    "Semantic search over ingested customer refund comments for a shop, " +
    "augmented by an entity knowledge graph (SKU / styleCode / returnReason / " +
    "size / color). Returns a synthesized Chinese answer based on retrieved " +
    "customer-comment evidence. " +
    "USE FOR: open-ended 'why are customers complaining' / 'what's the real " +
    "issue behind this return-reason code' / 'main complaints for SKU X' " +
    "semantic questions. CN and EN queries both work natively via the multilingual bge-m3 embedding (no translation step). " +
    "DO NOT USE FOR: structured filtering (specific orderId, exact SKU+date " +
    "lookups, quantity thresholds) — use dws.refundComments instead. " +
    "ON ERROR: any error class (typically 'UpstreamError' when the RAG " +
    "service is down) means you should retry with dws.refundComments + a " +
    "CN keyword LIKE filter, and note '⚠️ RAG 暂不可用' in the reply. " +
    "CURRENT INGEST: EP-US only, 380 docs (Phase 2a snapshot). " +
    "Other shops will reject at validation.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: [],
  handler,
};
