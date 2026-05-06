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

const { adsetPerformanceDescriptor } = await import("./adsetPerformance.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "meta.adsetPerformance",
  argsHash: "e".repeat(64),
} as const;

describe("meta.adsetPerformance", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      accessToken: "EAAB1234567890abcdefghij",
      apiVersion: "v20.0",
    });
  });

  it("forwards date range to the helper and returns rows", async () => {
    const rows = [
      { adset_id: "111", adset_name: "AS-A", spend: "120.5" },
      { adset_id: "222", adset_name: "AS-B", spend: "80.0" },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows });
    const input = adsetPerformanceDescriptor.inputSchema.parse({
      accountId: "act_138486201",
      since: "2026-04-01",
      until: "2026-04-28",
    });

    await expect(adsetPerformanceDescriptor.handler(ctx, input)).resolves.toEqual({ rows });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "adsetPerformance",
          accountId: "act_138486201",
          since: "2026-04-01",
          until: "2026-04-28",
        },
        envFromSecrets: {
          META_ACCESS_TOKEN: "EAAB1234567890abcdefghij",
          META_API_VERSION: "v20.0",
        },
      }),
    );
  });

  it("rejects since > until", () => {
    expect(() =>
      adsetPerformanceDescriptor.inputSchema.parse({
        accountId: "138486201",
        since: "2026-04-30",
        until: "2026-04-01",
      }),
    ).toThrow();
  });

  it("rejects malformed dates", () => {
    expect(() =>
      adsetPerformanceDescriptor.inputSchema.parse({
        accountId: "138486201",
        since: "2026/04/01",
        until: "2026-04-28",
      }),
    ).toThrow();
  });

  it("validates output rows is an array", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: "not-an-array" });
    const input = adsetPerformanceDescriptor.inputSchema.parse({
      accountId: "138486201",
      since: "2026-04-01",
      until: "2026-04-28",
    });

    await expect(adsetPerformanceDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
