import { describe, expect, it, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCompanySecrets: vi.fn(),
  runPythonHelper: vi.fn(),
}));

vi.mock("../../secrets.js", () => ({
  loadCompanySecrets: mocks.loadCompanySecrets,
}));

vi.mock("../../subprocess.js", () => ({
  runPythonHelper: mocks.runPythonHelper,
}));

const { listCollectionsDescriptor } = await import("./listCollections.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "shopify.listCollections",
  argsHash: "c".repeat(64),
} as const;

describe("shopify.listCollections", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      shop: "paperclip-test",
      token: "shpat_12345678901234567890",
      apiVersion: "2024-10",
    });
  });

  it("lists collections through the python helper and returns the collections", async () => {
    const collections = [
      { id: 111, handle: "summer", title: "Summer", collectionType: "custom" },
      { id: 222, handle: "best-sellers", title: "Best Sellers", collectionType: "smart" },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", collections });
    const input = listCollectionsDescriptor.inputSchema.parse({ limit: 25, titleContains: "summer" });

    await expect(listCollectionsDescriptor.handler(ctx, input)).resolves.toEqual({ collections });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "shopify");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/shopify/_query.py"),
        request: { version: "1", op: "listCollections", limit: 25, titleContains: "summer" },
        envFromSecrets: {
          SHOPIFY_SHOP: "paperclip-test",
          SHOPIFY_TOKEN: "shpat_12345678901234567890",
          SHOPIFY_API_VERSION: "2024-10",
        },
        timeoutMs: 25_000,
      }),
    );
  });

  it("applies the default limit when none is provided", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", collections: [] });
    const input = listCollectionsDescriptor.inputSchema.parse({});

    await expect(listCollectionsDescriptor.handler(ctx, input)).resolves.toEqual({ collections: [] });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { version: "1", op: "listCollections", limit: 50, titleContains: undefined },
      }),
    );
  });

  it("rejects unknown keys at input validation", () => {
    expect(() => listCollectionsDescriptor.inputSchema.parse({ bogus: true })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit at input validation", () => {
    expect(() => listCollectionsDescriptor.inputSchema.parse({ limit: 0 })).toThrow();
    expect(() => listCollectionsDescriptor.inputSchema.parse({ limit: 251 })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1" });
    const input = listCollectionsDescriptor.inputSchema.parse({});

    await expect(listCollectionsDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
