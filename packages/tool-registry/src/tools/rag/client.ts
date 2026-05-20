const DEFAULT_BASE = "http://127.0.0.1:9001";
const TIMEOUT_MS = 30_000;

export class RagUnavailable extends Error {}

export interface RagSearchInput {
  collection: string;
  query: string;
  topK?: number;
}

export interface RagSearchOk {
  answer: string;
  references?: Array<{ reference_id: string; file_path: string }>;
  meta?: {
    translation?: string | null;
    originalQuery?: string | null;
    translatedQuery?: string | null;
    translateMs?: number | null;
    fallbackReason?: string | null;
  } | null;
}

export async function ragSearch(input: RagSearchInput): Promise<RagSearchOk> {
  const base = process.env.RAG_API_BASE ?? DEFAULT_BASE;
  const url = `${base.replace(/\/+$/, "")}/search`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collection: input.collection,
        query: input.query,
        top_k: input.topK ?? 10,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new RagUnavailable(`rag /search returned HTTP ${response.status}`);
    }

    return (await response.json()) as RagSearchOk;
  } catch (e: unknown) {
    if (e instanceof RagUnavailable) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new RagUnavailable(`rag service unreachable: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
