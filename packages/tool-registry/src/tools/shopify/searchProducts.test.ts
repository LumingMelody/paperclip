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

const { searchProductsDescriptor } = await import("./searchProducts.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "shopify.searchProducts",
  argsHash: "c".repeat(64),
} as const;

describe("shopify.searchProducts", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      shop: "paperclip-test",
      token: "shpat_12345678901234567890",
      apiVersion: "2024-10",
    });
  });

  it("queries Shopify with the searchProducts op and returns the products", async () => {
    const products = [
      { id: 1, handle: "alpha", title: "Alpha" },
      { id: 2, handle: "beta", title: "Beta" },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", products });
    const input = searchProductsDescriptor.inputSchema.parse({
      status: "active",
      vendor: "Acme",
      productType: "Widget",
      collectionId: "123456789",
      title: "Alpha",
      limit: 25,
    });

    await expect(searchProductsDescriptor.handler(ctx, input)).resolves.toEqual({ products });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "shopify");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/shopify/_query.py"),
        request: {
          version: "1",
          op: "searchProducts",
          status: "active",
          vendor: "Acme",
          productType: "Widget",
          collectionId: "123456789",
          title: "Alpha",
          limit: 25,
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

  it("defaults limit to 50 when omitted", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", products: [] });
    const input = searchProductsDescriptor.inputSchema.parse({ vendor: "Acme" });

    await expect(searchProductsDescriptor.handler(ctx, input)).resolves.toEqual({ products: [] });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "searchProducts",
          status: undefined,
          vendor: "Acme",
          productType: undefined,
          collectionId: undefined,
          title: undefined,
          limit: 50,
        },
      }),
    );
  });

  it("rejects an invalid status enum at input validation", () => {
    expect(() => searchProductsDescriptor.inputSchema.parse({ status: "published" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects unknown keys at input validation (strict schema)", () => {
    expect(() => searchProductsDescriptor.inputSchema.parse({ handle: "alpha" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects limit above the 250 cap at input validation", () => {
    expect(() => searchProductsDescriptor.inputSchema.parse({ limit: 1000 })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("accepts an empty input object and applies the default limit", () => {
    const input = searchProductsDescriptor.inputSchema.parse({});
    expect(input.limit).toBe(50);
  });

  it("validates the helper output shape (missing products array)", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1" });
    const input = searchProductsDescriptor.inputSchema.parse({ vendor: "Acme" });

    await expect(searchProductsDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
