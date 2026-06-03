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

const { siteReturnRateByOrderUnitsDescriptor } = await import("./siteReturnRateByOrderUnits.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.siteReturnRateByOrderUnits",
  argsHash: "c".repeat(64),
} as const;

const metadata = {
  asOfDate: "2026-06-03",
  windowStart: "2026-01-01",
  windowEnd: "2026-04-19",
  maturityDays: 45,
  windowIncludesImmature: false,
};

describe("dws.siteReturnRateByOrderUnits", () => {
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

  it("queries order-unit buckets through the DWS helper", async () => {
    const rows = [
      { unitsBucket: "1", orderCount: 100, salesQty: 100, returnQty: 12, returnRate: 0.12 },
      { unitsBucket: "5+", orderCount: 10, salesQty: 60, returnQty: 9, returnRate: 0.15 },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows, ...metadata });
    const input = siteReturnRateByOrderUnitsDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01" });

    await expect(siteReturnRateByOrderUnitsDescriptor.handler(ctx, input)).resolves.toEqual({ rows, ...metadata });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteReturnRateByOrderUnits",
          account: "EPSITEUS",
          since: "2026-01-01",
          until: undefined,
          maturityDays: 45,
        },
      }),
    );
  });

  it("forwards explicit until and maturityDays", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [], ...metadata });
    const input = siteReturnRateByOrderUnitsDescriptor.inputSchema.parse({
      site: "UK",
      since: "2026-02-01",
      until: "2026-05-01",
      maturityDays: 30,
    });

    await siteReturnRateByOrderUnitsDescriptor.handler(ctx, input);

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteReturnRateByOrderUnits",
          account: "EPSITEUK",
          since: "2026-02-01",
          until: "2026-05-01",
          maturityDays: 30,
        },
      }),
    );
  });

  it("rejects AU and unknown keys", () => {
    expect(() => siteReturnRateByOrderUnitsDescriptor.inputSchema.parse({ site: "AU", since: "2026-01-01" })).toThrow();
    expect(() =>
      siteReturnRateByOrderUnitsDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01", top: 10 }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows: [{ unitsBucket: "6", orderCount: 1, salesQty: 6, returnQty: 1, returnRate: 0.1667 }],
      ...metadata,
    });
    const input = siteReturnRateByOrderUnitsDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01" });

    await expect(siteReturnRateByOrderUnitsDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
