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

const { listLocationsDescriptor } = await import("./listLocations.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "shopify.listLocations",
  argsHash: "c".repeat(64),
} as const;

describe("shopify.listLocations", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      shop: "paperclip-test",
      token: "shpat_12345678901234567890",
      apiVersion: "2024-10",
    });
  });

  it("lists Shopify locations through the python helper and returns them", async () => {
    const locations = [
      { id: 1, name: "Main Warehouse", active: true },
      { id: 2, name: "Retail Store", active: false },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", locations });
    const input = listLocationsDescriptor.inputSchema.parse({});

    await expect(listLocationsDescriptor.handler(ctx, input)).resolves.toEqual({ locations });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "shopify");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/shopify/_query.py"),
        request: { version: "1", op: "listLocations" },
        envFromSecrets: {
          SHOPIFY_SHOP: "paperclip-test",
          SHOPIFY_TOKEN: "shpat_12345678901234567890",
          SHOPIFY_API_VERSION: "2024-10",
        },
        timeoutMs: 25_000,
      }),
    );
  });

  it("accepts an empty input object at input validation", () => {
    expect(listLocationsDescriptor.inputSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys at input validation", () => {
    expect(() => listLocationsDescriptor.inputSchema.parse({ limit: 10 })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1" });
    const input = listLocationsDescriptor.inputSchema.parse({});

    await expect(listLocationsDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
