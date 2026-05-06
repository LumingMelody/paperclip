import { describe, expect, it, beforeEach, vi } from "vitest";
import { UpstreamError } from "../../errors.js";

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

const { adAccountSummaryDescriptor } = await import("./adAccountSummary.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "meta.adAccountSummary",
  argsHash: "d".repeat(64),
} as const;

describe("meta.adAccountSummary", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      accessToken: "EAAB1234567890abcdefghij",
      apiVersion: "v20.0",
    });
  });

  it("queries Meta for account fields through the python helper", async () => {
    const account = {
      id: "act_138486201",
      name: "Ever Pretty",
      currency: "USD",
      account_status: 1,
    };
    mocks.runPythonHelper.mockResolvedValue({ version: "1", account });
    const input = adAccountSummaryDescriptor.inputSchema.parse({ accountId: "138486201" });

    await expect(adAccountSummaryDescriptor.handler(ctx, input)).resolves.toEqual({ account });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "meta");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/meta/_query.py"),
        request: { version: "1", op: "adAccountSummary", accountId: "138486201" },
        envFromSecrets: {
          META_ACCESS_TOKEN: "EAAB1234567890abcdefghij",
          META_API_VERSION: "v20.0",
        },
        timeoutMs: 25_000,
      }),
    );
  });

  it("accepts accountId with act_ prefix", () => {
    expect(() => adAccountSummaryDescriptor.inputSchema.parse({ accountId: "act_138486201" })).not.toThrow();
  });

  it("rejects non-numeric accountId", () => {
    expect(() => adAccountSummaryDescriptor.inputSchema.parse({ accountId: "ever-pretty" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("propagates upstream errors from the helper", async () => {
    mocks.runPythonHelper.mockRejectedValue(new UpstreamError("HTTP 401: token expired"));
    const input = adAccountSummaryDescriptor.inputSchema.parse({ accountId: "138486201" });

    await expect(adAccountSummaryDescriptor.handler(ctx, input)).rejects.toThrow(UpstreamError);
  });
});
