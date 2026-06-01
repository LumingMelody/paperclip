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

const { getProductByIdDescriptor } = await import("./getProductById.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "shopify.getProductById",
  argsHash: "c".repeat(64),
} as const;

describe("shopify.getProductById", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      shop: "paperclip-test",
      token: "shpat_12345678901234567890",
      apiVersion: "2024-10",
    });
  });

  it("queries Shopify by numeric product id through the python helper and returns the product", async () => {
    const product = { id: 123456789, handle: "some-product", title: "Some Product" };
    mocks.runPythonHelper.mockResolvedValue({ version: "1", product });
    const input = getProductByIdDescriptor.inputSchema.parse({ productId: "123456789" });

    await expect(getProductByIdDescriptor.handler(ctx, input)).resolves.toEqual({ product });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "shopify");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/shopify/_query.py"),
        request: { version: "1", op: "getProductById", productId: "123456789" },
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
    mocks.runPythonHelper.mockRejectedValue(new NotFound("no product with id '999999999'"));
    const input = getProductByIdDescriptor.inputSchema.parse({ productId: "999999999" });

    await expect(getProductByIdDescriptor.handler(ctx, input)).rejects.toThrow(NotFound);
  });

  it("rejects non-numeric product ids at input validation", () => {
    expect(() => getProductByIdDescriptor.inputSchema.parse({ productId: "some-product" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1" });
    const input = getProductByIdDescriptor.inputSchema.parse({ productId: "123456789" });

    await expect(getProductByIdDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
