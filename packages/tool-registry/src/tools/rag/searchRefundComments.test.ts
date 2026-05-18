import { describe, expect, it, vi } from "vitest";
import { UpstreamError, ValidationError } from "../../errors.js";

vi.mock("./client.js", () => ({
  ragSearch: vi.fn(),
  RagUnavailable: class RagUnavailable extends Error {},
}));

const { searchRefundCommentsDescriptor } = await import("./searchRefundComments.js");
const { ragSearch, RagUnavailable } = await import("./client.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "rag.searchRefundComments",
  argsHash: "r".repeat(64),
} as const;

describe("rag.searchRefundComments descriptor", () => {
  it("registers as id rag.searchRefundComments with kebab cliSubcommand", () => {
    expect(searchRefundCommentsDescriptor.id).toBe("rag.searchRefundComments");
    expect(searchRefundCommentsDescriptor.source).toBe("rag");
    expect(searchRefundCommentsDescriptor.cliSubcommand).toBe("search-refund-comments");
    expect(searchRefundCommentsDescriptor.requiredSecrets).toEqual([]);
  });

  it("rejects unsupported shops via zod refine", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "PZ-US",
      query: "hi",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/not yet ingested/);
      expect(r.error.issues[0].message).toMatch(/EP-US/);
    }
  });

  it("rejects malformed shop pattern", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "notashop",
      query: "hi",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty query", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "EP-US",
      query: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects query longer than 500 chars", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "EP-US",
      query: "x".repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it("happy path returns parsed RAG response", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({
      answer: "顾客抱怨胸围",
      meta: { translation: "translated", translateMs: 412 },
    });

    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      shop: "EP-US",
      query: "胸围紧",
    });

    expect(out.answer).toBe("顾客抱怨胸围");
    expect(out.meta?.translation).toBe("translated");
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "胸围紧",
      topK: undefined,
    });
  });

  it("forwards topK when provided", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "x" });
    await searchRefundCommentsDescriptor.handler(ctx as any, {
      shop: "EP-US",
      query: "x",
      topK: 25,
    });
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "x",
      topK: 25,
    });
  });

  it("wraps RagUnavailable as UpstreamError", async () => {
    vi.mocked(ragSearch).mockRejectedValueOnce(
      new (RagUnavailable as any)("rag /search returned HTTP 503"),
    );

    await expect(
      searchRefundCommentsDescriptor.handler(ctx as any, {
        shop: "EP-US",
        query: "x",
      }),
    ).rejects.toThrow(UpstreamError);

    vi.mocked(ragSearch).mockRejectedValueOnce(
      new (RagUnavailable as any)("rag /search returned HTTP 503"),
    );

    await expect(
      searchRefundCommentsDescriptor.handler(ctx as any, {
        shop: "EP-US",
        query: "x",
      }),
    ).rejects.toThrow(/rag service unavailable.*HTTP 503/);
  });

  it("does NOT wrap unknown errors as UpstreamError", async () => {
    vi.mocked(ragSearch).mockRejectedValueOnce(new TypeError("totally unexpected"));

    await expect(
      searchRefundCommentsDescriptor.handler(ctx as any, {
        shop: "EP-US",
        query: "x",
      }),
    ).rejects.toThrow(TypeError);
  });
});
