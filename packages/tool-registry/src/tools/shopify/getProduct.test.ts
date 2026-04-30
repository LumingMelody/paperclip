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

const { getProductDescriptor } = await import("./getProduct.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "shopify.getProduct",
  argsHash: "c".repeat(64),
} as const;

describe("shopify.getProduct", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      shop: "paperclip-test",
      token: "shpat_12345678901234567890",
      apiVersion: "2024-10",
    });
  });

  it("queries Shopify by handle through the python helper and returns the product", async () => {
    const product = { id: 123, handle: "some-product", title: "Some Product" };
    mocks.runPythonHelper.mockResolvedValue({ version: "1", product });
    const input = getProductDescriptor.inputSchema.parse({ handle: "some-product" });

    await expect(getProductDescriptor.handler(ctx, input)).resolves.toEqual({ product });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "shopify");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/shopify/_query.py"),
        request: { version: "1", op: "getProduct", handle: "some-product" },
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
    mocks.runPythonHelper.mockRejectedValue(new NotFound("no product with handle 'missing-product'"));
    const input = getProductDescriptor.inputSchema.parse({ handle: "missing-product" });

    await expect(getProductDescriptor.handler(ctx, input)).rejects.toThrow(NotFound);
  });

  it("rejects uppercase handles at input validation", () => {
    expect(() => getProductDescriptor.inputSchema.parse({ handle: "Some-Product" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1" });
    const input = getProductDescriptor.inputSchema.parse({ handle: "some-product" });

    await expect(getProductDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
