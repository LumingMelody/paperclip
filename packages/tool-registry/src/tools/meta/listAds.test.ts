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

const { listAdsDescriptor } = await import("./listAds.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "meta.listAds",
  argsHash: "b".repeat(64),
} as const;

describe("meta.listAds", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      accessToken: "EAAB1234567890abcdefghij",
      apiVersion: "v20.0",
    });
  });

  it("forwards account, campaign filter, and effective statuses to the helper", async () => {
    const ads = [
      {
        id: "333",
        name: "Ad A",
        campaign_id: "111",
        creative: { id: "444", thumbnail_url: "https://example.test/thumb.jpg" },
      },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", ads });
    const input = listAdsDescriptor.inputSchema.parse({
      accountId: "act_138486201",
      campaignId: "111",
      effectiveStatus: ["ACTIVE"],
    });

    await expect(listAdsDescriptor.handler(ctx, input)).resolves.toEqual({ ads });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "listAds",
          accountId: "act_138486201",
          campaignId: "111",
          effectiveStatus: ["ACTIVE"],
        },
        envFromSecrets: {
          META_ACCESS_TOKEN: "EAAB1234567890abcdefghij",
          META_API_VERSION: "v20.0",
        },
      }),
    );
  });

  it("accepts an account-only list request", () => {
    expect(() => listAdsDescriptor.inputSchema.parse({ accountId: "138486201" })).not.toThrow();
  });

  it("rejects empty campaignId", () => {
    expect(() =>
      listAdsDescriptor.inputSchema.parse({
        accountId: "138486201",
        campaignId: "",
      }),
    ).toThrow();
  });

  it("validates output ads is an array", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", ads: "not-an-array" });
    const input = listAdsDescriptor.inputSchema.parse({ accountId: "138486201" });

    await expect(listAdsDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
