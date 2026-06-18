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

const { insightsDescriptor } = await import("./insights.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "meta.insights",
  argsHash: "f".repeat(64),
} as const;

describe("meta.insights", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      accessToken: "EAAB1234567890abcdefghij",
      apiVersion: "v20.0",
    });
  });

  it("defaults to account-level all-days insights and returns rows", async () => {
    const rows = [{ account_id: "act_138486201", spend: "120.5" }];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows });
    const input = insightsDescriptor.inputSchema.parse({
      accountId: "138486201",
      since: "2026-04-01",
      until: "2026-04-28",
    });

    await expect(insightsDescriptor.handler(ctx, input)).resolves.toEqual({ rows });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "insights",
          accountId: "138486201",
          since: "2026-04-01",
          until: "2026-04-28",
          level: "account",
          timeIncrement: "all_days",
        },
        envFromSecrets: {
          META_ACCESS_TOKEN: "EAAB1234567890abcdefghij",
          META_API_VERSION: "v20.0",
        },
      }),
    );
  });

  it("forwards level, breakdowns, and daily time increment", async () => {
    const rows = [{ ad_id: "444", age: "25-34", date_start: "2026-04-01", spend: "10.5" }];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows });
    const input = insightsDescriptor.inputSchema.parse({
      accountId: "act_138486201",
      since: "2026-04-01",
      until: "2026-04-28",
      level: "ad",
      breakdowns: ["age", "gender", "publisher_platform"],
      timeIncrement: "1",
    });

    await expect(insightsDescriptor.handler(ctx, input)).resolves.toEqual({ rows });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "insights",
          accountId: "act_138486201",
          since: "2026-04-01",
          until: "2026-04-28",
          level: "ad",
          breakdowns: ["age", "gender", "publisher_platform"],
          timeIncrement: "1",
        },
      }),
    );
  });

  it("rejects since > until", () => {
    expect(() =>
      insightsDescriptor.inputSchema.parse({
        accountId: "138486201",
        since: "2026-04-30",
        until: "2026-04-01",
      }),
    ).toThrow();
  });

  it("rejects unsupported breakdowns", () => {
    expect(() =>
      insightsDescriptor.inputSchema.parse({
        accountId: "138486201",
        since: "2026-04-01",
        until: "2026-04-28",
        breakdowns: ["device_platform"],
      }),
    ).toThrow();
  });
});
