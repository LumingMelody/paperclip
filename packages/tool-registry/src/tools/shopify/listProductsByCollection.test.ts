import { describe, expect, it, beforeEach, vi } from "vitest";
import { NotFound } from "../../errors.js";

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

const { listProductsByCollectionDescriptor } = await import("./listProductsByCollection.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "shopify.listProductsByCollection",
  argsHash: "d".repeat(64),
} as const;

describe("shopify.listProductsByCollection", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      shop: "paperclip-test",
      token: "shpat_12345678901234567890",
      apiVersion: "2024-10",
    });
  });

  it("queries Shopify collection products through the python helper and returns products", async () => {
    const products = [
      { id: 123, handle: "first-product" },
      { id: 456, handle: "second-product" },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", products });
    const input = listProductsByCollectionDescriptor.inputSchema.parse({ collectionId: "987654321" });

    await expect(listProductsByCollectionDescriptor.handler(ctx, input)).resolves.toEqual({ products });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "shopify");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/shopify/_query.py"),
        request: {
          version: "1",
          op: "listProductsByCollection",
          collectionId: "987654321",
          limit: 50,
        },
        envFromSecrets: {
          SHOPIFY_SHOP: "paperclip-test",
          SHOPIFY_TOKEN: "shpat_12345678901234567890",
          SHOPIFY_API_VERSION: "2024-10",
        },
        timeoutMs: 25_000,
      }),
    );
  });

  it("surfaces NotFound from the subprocess error classification", async () => {
    mocks.runPythonHelper.mockRejectedValue(new NotFound("collection not found"));
    const input = listProductsByCollectionDescriptor.inputSchema.parse({ collectionId: "987654321", limit: 10 });

    await expect(listProductsByCollectionDescriptor.handler(ctx, input)).rejects.toThrow(NotFound);
  });

  it("rejects limits outside Shopify's REST range", () => {
    expect(() => listProductsByCollectionDescriptor.inputSchema.parse({ collectionId: "987654321", limit: 251 })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", products: "not an array" });
    const input = listProductsByCollectionDescriptor.inputSchema.parse({ collectionId: "987654321", limit: 10 });

    await expect(listProductsByCollectionDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
