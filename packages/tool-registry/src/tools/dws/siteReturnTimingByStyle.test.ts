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

const { siteReturnTimingByStyleDescriptor } = await import("./siteReturnTimingByStyle.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.siteReturnTimingByStyle",
  argsHash: "c".repeat(64),
} as const;

const metadata = {
  asOfDate: "2026-06-03",
  windowStart: "2026-01-01",
  windowEnd: "2026-04-19",
  maturityDays: 45,
  windowIncludesImmature: false,
};

describe("dws.siteReturnTimingByStyle", () => {
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

  it("queries returned-unit timing buckets through the DWS helper", async () => {
    const rows = [
      {
        styleCode: "EE02401",
        returnedQty: 100,
        qty_0_30: 60,
        qty_31_45: 25,
        qty_45plus: 15,
        pct_0_30: 0.6,
        pct_31_45: 0.25,
        pct_45plus: 0.15,
      },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows, ...metadata });
    const input = siteReturnTimingByStyleDescriptor.inputSchema.parse({ site: "FR", since: "2026-01-01" });

    await expect(siteReturnTimingByStyleDescriptor.handler(ctx, input)).resolves.toEqual({ rows, ...metadata });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteReturnTimingByStyle",
          account: "EPSITEFR",
          since: "2026-01-01",
          until: undefined,
          top: 20,
          maturityDays: 45,
          style: undefined,
        },
      }),
    );
  });

  it("forwards explicit until, maturityDays, top, and style", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [], ...metadata });
    const input = siteReturnTimingByStyleDescriptor.inputSchema.parse({
      site: "DE",
      since: "2026-02-01",
      until: "2026-05-01",
      maturityDays: 30,
      top: 3,
      style: "EP07906",
    });

    await siteReturnTimingByStyleDescriptor.handler(ctx, input);

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteReturnTimingByStyle",
          account: "EPSITEDE",
          since: "2026-02-01",
          until: "2026-05-01",
          top: 3,
          maturityDays: 30,
          style: "EP07906",
        },
      }),
    );
  });

  it("rejects AU and out-of-range maturityDays", () => {
    expect(() => siteReturnTimingByStyleDescriptor.inputSchema.parse({ site: "AU", since: "2026-01-01" })).toThrow();
    expect(() =>
      siteReturnTimingByStyleDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01", maturityDays: 181 }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [{ styleCode: "EE02401" }], ...metadata });
    const input = siteReturnTimingByStyleDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01" });

    await expect(siteReturnTimingByStyleDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
