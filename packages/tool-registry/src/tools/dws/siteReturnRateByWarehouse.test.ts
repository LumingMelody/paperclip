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

const { siteReturnRateByWarehouseDescriptor } = await import("./siteReturnRateByWarehouse.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.siteReturnRateByWarehouse",
  argsHash: "c".repeat(64),
} as const;

const metadata = {
  asOfDate: "2026-06-03",
  windowStart: "2026-01-01",
  windowEnd: "2026-04-19",
  maturityDays: 45,
  windowIncludesImmature: false,
};

describe("dws.siteReturnRateByWarehouse", () => {
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

  it("queries raw warehouse buckets through the DWS helper", async () => {
    const rows = [
      { warehouseName: "US West", salesQty: 600, returnQty: 72, returnRate: 0.12, returnShare: 0.8 },
      { warehouseName: "无仓库记录", salesQty: 100, returnQty: 18, returnRate: 0.18, returnShare: 0.2 },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows, dirtyWarehousePct: 0.05, ...metadata });
    const input = siteReturnRateByWarehouseDescriptor.inputSchema.parse({ site: "FR", since: "2026-01-01" });

    await expect(siteReturnRateByWarehouseDescriptor.handler(ctx, input)).resolves.toEqual({
      rows,
      dirtyWarehousePct: 0.05,
      ...metadata,
    });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteReturnRateByWarehouse",
          account: "EPSITEFR",
          since: "2026-01-01",
          until: undefined,
          maturityDays: 45,
        },
      }),
    );
  });

  it("forwards explicit until and maturityDays", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [], dirtyWarehousePct: 0, ...metadata });
    const input = siteReturnRateByWarehouseDescriptor.inputSchema.parse({
      site: "DE",
      since: "2026-02-01",
      until: "2026-05-01",
      maturityDays: 30,
    });

    await siteReturnRateByWarehouseDescriptor.handler(ctx, input);

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteReturnRateByWarehouse",
          account: "EPSITEDE",
          since: "2026-02-01",
          until: "2026-05-01",
          maturityDays: 30,
        },
      }),
    );
  });

  it("rejects AU and malformed until dates", () => {
    expect(() => siteReturnRateByWarehouseDescriptor.inputSchema.parse({ site: "AU", since: "2026-01-01" })).toThrow();
    expect(() =>
      siteReturnRateByWarehouseDescriptor.inputSchema.parse({
        site: "US",
        since: "2026-01-01",
        until: "2026/05/01",
      }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows: [{ warehouseName: "US West", salesQty: 600 }],
      dirtyWarehousePct: 0.05,
      ...metadata,
    });
    const input = siteReturnRateByWarehouseDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01" });

    await expect(siteReturnRateByWarehouseDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
