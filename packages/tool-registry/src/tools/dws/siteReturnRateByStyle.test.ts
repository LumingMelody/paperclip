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

const { siteReturnRateByStyleDescriptor } = await import("./siteReturnRateByStyle.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.siteReturnRateByStyle",
  argsHash: "c".repeat(64),
} as const;

const metadata = {
  asOfDate: "2026-06-03",
  windowStart: "2026-01-01",
  windowEnd: "2026-04-19",
  maturityDays: 45,
  windowIncludesImmature: false,
};

describe("dws.siteReturnRateByStyle", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      host: "dws-test-host",
      port: "3306",
      user: "dws_user",
      password: "dws_password",
      database: "dws_db",
    });
  });

  it("queries Shopify site return rates through the DWS helper with mature-window defaults", async () => {
    const rows = [
      { styleCode: "EE02401", salesQty: 1200, returnQty: 96, returnRate: 0.08, skuCount: 14 },
      { styleCode: "EP07906", salesQty: 800, returnQty: 40, returnRate: 0.05, skuCount: 9 },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows, ...metadata });
    const input = siteReturnRateByStyleDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01" });

    await expect(siteReturnRateByStyleDescriptor.handler(ctx, input)).resolves.toEqual({ rows, ...metadata });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "dws");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/dws/_query.py"),
        request: {
          version: "1",
          op: "siteReturnRateByStyle",
          account: "EPSITEUS",
          since: "2026-01-01",
          until: undefined,
          top: 20,
          minQty: 50,
          maturityDays: 45,
          style: undefined,
        },
      }),
    );
  });

  it("forwards explicit filters and overrides", async () => {
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows: [],
      ...metadata,
      windowEnd: "2026-05-01",
      maturityDays: 30,
      windowIncludesImmature: true,
    });
    const input = siteReturnRateByStyleDescriptor.inputSchema.parse({
      site: "UK",
      since: "2026-02-01",
      until: "2026-05-01",
      top: 5,
      minQty: 100,
      maturityDays: 30,
      style: "EE02401",
    });

    await siteReturnRateByStyleDescriptor.handler(ctx, input);

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteReturnRateByStyle",
          account: "EPSITEUK",
          since: "2026-02-01",
          until: "2026-05-01",
          top: 5,
          minQty: 100,
          maturityDays: 30,
          style: "EE02401",
        },
      }),
    );
  });

  it("rejects AU and malformed dates at input validation", () => {
    expect(() => siteReturnRateByStyleDescriptor.inputSchema.parse({ site: "AU", since: "2026-01-01" })).toThrow();
    expect(() => siteReturnRateByStyleDescriptor.inputSchema.parse({ site: "US", since: "2026/01/01" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [{ styleCode: "EE02401" }], ...metadata });
    const input = siteReturnRateByStyleDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01" });

    await expect(siteReturnRateByStyleDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
