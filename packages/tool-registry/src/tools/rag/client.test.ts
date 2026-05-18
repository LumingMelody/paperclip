import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ragSearch, RagUnavailable } from "./client.js";

const realFetch = globalThis.fetch;

describe("ragSearch", () => {
  beforeEach(() => {
    delete process.env.RAG_API_BASE;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RAG_API_BASE;
  });

  it("posts to /search at the default base and returns parsed JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ answer: "hi", meta: { translation: "translated" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await ragSearch({ collection: "refund_comments", query: "做工", topK: 5 });

    expect(out.answer).toBe("hi");
    expect(out.meta?.translation).toBe("translated");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9001/search");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ collection: "refund_comments", query: "做工", top_k: 5 });
  });

  it("honors RAG_API_BASE env override and strips trailing slashes", async () => {
    process.env.RAG_API_BASE = "http://rag.internal:8000/";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ answer: "x" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ragSearch({ collection: "c", query: "q" });

    expect(fetchMock.mock.calls[0]![0]).toBe("http://rag.internal:8000/search");
  });

  it("defaults top_k to 10 when not provided", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ answer: "x" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ragSearch({ collection: "c", query: "q" });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.top_k).toBe(10);
  });

  it("throws RagUnavailable on non-2xx HTTP", async () => {
    globalThis.fetch = vi.fn(async () => new Response("oops", { status: 502 })) as unknown as typeof fetch;

    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(RagUnavailable);
    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(/HTTP 502/);
  });

  it("throws RagUnavailable on network error (fetch rejects)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("ECONNREFUSED 127.0.0.1:9001");
    }) as unknown as typeof fetch;

    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(RagUnavailable);
    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws RagUnavailable when body is not JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>not json</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(RagUnavailable);
  });
});
