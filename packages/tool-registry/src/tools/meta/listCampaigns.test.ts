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

const { listCampaignsDescriptor } = await import("./listCampaigns.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "meta.listCampaigns",
  argsHash: "a".repeat(64),
} as const;

describe("meta.listCampaigns", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      accessToken: "EAAB1234567890abcdefghij",
      apiVersion: "v20.0",
    });
  });

  it("forwards account, effective statuses, and limit to the helper", async () => {
    const campaigns = [
      { id: "111", name: "Campaign A", effective_status: "ACTIVE" },
      { id: "222", name: "Campaign B", effective_status: "PAUSED" },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", campaigns });
    const input = listCampaignsDescriptor.inputSchema.parse({
      accountId: "act_138486201",
      effectiveStatus: ["ACTIVE", "PAUSED"],
      limit: 250,
    });

    await expect(listCampaignsDescriptor.handler(ctx, input)).resolves.toEqual({ campaigns });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "listCampaigns",
          accountId: "act_138486201",
          effectiveStatus: ["ACTIVE", "PAUSED"],
          limit: 250,
        },
        envFromSecrets: {
          META_ACCESS_TOKEN: "EAAB1234567890abcdefghij",
          META_API_VERSION: "v20.0",
        },
      }),
    );
  });

  it("rejects non-array effectiveStatus", () => {
    expect(() =>
      listCampaignsDescriptor.inputSchema.parse({
        accountId: "138486201",
        effectiveStatus: "ACTIVE",
      }),
    ).toThrow();
  });

  it("rejects non-numeric accountId", () => {
    expect(() =>
      listCampaignsDescriptor.inputSchema.parse({
        accountId: "campaign-account",
      }),
    ).toThrow();
  });

  it("validates output campaigns is an array", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", campaigns: "not-an-array" });
    const input = listCampaignsDescriptor.inputSchema.parse({ accountId: "138486201" });

    await expect(listCampaignsDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
