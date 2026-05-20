import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../../errors.js";

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

  it("rejects malformed shop pattern", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "notashop",
      query: "hi",
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema accepts input with shop omitted", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      query: "EE02968 的主要投诉",
    });
    expect(r.success).toBe(true);
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

  it("accepts a valid shop and injects it as a query hint", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "顾客抱怨胸围" });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      shop: "EP-UK",
      query: "胸围紧",
    });
    expect(out.answer).toBe("顾客抱怨胸围");
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "（限定店铺：EP-UK）胸围紧",
      topK: undefined,
    });
  });

  it("works with shop omitted (cross-market) and does not inject a hint", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "跨市场答案" });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "EE02968 的主要投诉",
    });
    expect(out.answer).toBe("跨市场答案");
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "EE02968 的主要投诉",
      topK: undefined,
    });
  });

  it("forwards topK when provided", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "x" });
    await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "x",
      topK: 25,
    });
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "x",
      topK: 25,
    });
  });

  it("appends a parsed source list to the answer", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({
      answer: "顾客主要抱怨尺码偏小。",
      references: [
        { reference_id: "1", file_path: "EP-UK/EE02968/302-111-222" },
        { reference_id: "2", file_path: "EP-DE/EG01923/303-444-555" },
      ],
    });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "尺码问题",
    });
    expect(out.answer).toContain("顾客主要抱怨尺码偏小。");
    expect(out.answer).toContain("**来源**");
    expect(out.answer).toContain("EP-UK / EE02968 / 302-111-222");
    expect(out.answer).toContain("EP-DE / EG01923 / 303-444-555");
    expect(out.references).toHaveLength(2);
  });

  it("caps the rendered source list at 8 and discloses the total", async () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({
      reference_id: String(i),
      file_path: `EP-US/SKU${i}/ord${i}`,
    }));
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "答案", references: refs });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "x",
    });
    expect(out.answer).toContain("共 10 条客户评论，显示前 8 条");
    expect(out.answer.match(/^- /gm)).toHaveLength(8);
    expect(out.references).toHaveLength(10);
  });

  it("leaves the answer untouched when there are no references", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "无证据答案", references: [] });
    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      query: "x",
    });
    expect(out.answer).toBe("无证据答案");
    expect(out.references).toEqual([]);
  });
});
