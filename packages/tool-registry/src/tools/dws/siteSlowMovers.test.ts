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

const { siteSlowMoversDescriptor } = await import("./siteSlowMovers.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.siteSlowMovers",
  argsHash: "c".repeat(64),
} as const;

describe("dws.siteSlowMovers", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      host: "dws.example.internal",
      port: "3306",
      user: "dws_reader",
      password: "dws_password_123",
      database: "dws_warehouse",
    });
  });

  it("queries DWS for a site through the python helper and returns the rows", async () => {
    const rows = [
      { styleCode: "EP12345", recentQty: 4, priorQty: 80, deltaQty: -76, dropPct: 0.95 },
      { styleCode: null, recentQty: 10, priorQty: 40, deltaQty: -30, dropPct: 0.75 },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows });
    const input = siteSlowMoversDescriptor.inputSchema.parse({ site: "US" });

    await expect(siteSlowMoversDescriptor.handler(ctx, input)).resolves.toEqual({ rows });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "dws");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/dws/_query.py"),
        request: {
          version: "1",
          op: "siteSlowMovers",
          account: "EPSITEUS",
          until: undefined,
          windowDays: 30,
          top: 20,
          minQty: 30,
          sort: "decline",
        },
        envFromSecrets: {
          DWS_DB_HOST: "dws.example.internal",
          DWS_DB_PORT: "3306",
          DWS_DB_USER: "dws_reader",
          DWS_DB_PASSWORD: "dws_password_123",
          DWS_DB_DATABASE: "dws_warehouse",
        },
      }),
    );
  });

  it("forwards optional params verbatim into the helper request", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [] });
    const input = siteSlowMoversDescriptor.inputSchema.parse({
      site: "UK",
      until: "2026-05-01",
      windowDays: 14,
      top: 5,
      minQty: 50,
      sort: "slow",
    });

    await expect(siteSlowMoversDescriptor.handler(ctx, input)).resolves.toEqual({ rows: [] });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteSlowMovers",
          account: "EPSITEUK",
          until: "2026-05-01",
          windowDays: 14,
          top: 5,
          minQty: 50,
          sort: "slow",
        },
      }),
    );
  });

  it("falls back to an empty string when the port secret is absent", async () => {
    mocks.loadCompanySecrets.mockResolvedValue({
      host: "dws.example.internal",
      user: "dws_reader",
      password: "dws_password_123",
      database: "dws_warehouse",
    });
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [] });
    const input = siteSlowMoversDescriptor.inputSchema.parse({ site: "DE" });

    await siteSlowMoversDescriptor.handler(ctx, input);

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        envFromSecrets: expect.objectContaining({ DWS_DB_PORT: "" }),
      }),
    );
  });

  it("rejects an out-of-range site at input validation", () => {
    expect(() => siteSlowMoversDescriptor.inputSchema.parse({ site: "JP" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects unknown keys (strict schema) at input validation", () => {
    expect(() =>
      siteSlowMoversDescriptor.inputSchema.parse({ site: "US", region: "west" }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("accepts a fully-specified valid input", () => {
    const parsed = siteSlowMoversDescriptor.inputSchema.parse({
      site: "AU",
      until: "2026-04-30",
      windowDays: 60,
      top: 10,
      minQty: 25,
      sort: "decline",
    });
    expect(parsed).toEqual({
      site: "AU",
      until: "2026-04-30",
      windowDays: 60,
      top: 10,
      minQty: 25,
      sort: "decline",
    });
  });

  it("validates the helper output row shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows: [{ styleCode: "EP12345" }],
    });
    const input = siteSlowMoversDescriptor.inputSchema.parse({ site: "US" });

    await expect(siteSlowMoversDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
