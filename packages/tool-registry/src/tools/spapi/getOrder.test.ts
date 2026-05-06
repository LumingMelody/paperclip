import { describe, expect, it, beforeEach, vi } from "vitest";
import { NotFound } from "../../errors.js";

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

const { getOrderDescriptor } = await import("./getOrder.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "spapi.getOrder",
  argsHash: "f".repeat(64),
} as const;

describe("spapi.getOrder", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      refreshToken: "Atzr|IwEBI" + "x".repeat(40),
      clientId: "amzn1.application-oa2-client.example",
      clientSecret: "secret-very-long-string-here",
      region: "na",
      marketplaceId: "ATVPDKIKX0DER",
    });
  });

  it("queries SP-API by orderId through the python helper", async () => {
    const order = { AmazonOrderId: "111-2345678-9012345", OrderStatus: "Shipped" };
    mocks.runPythonHelper.mockResolvedValue({ version: "1", order });
    const input = getOrderDescriptor.inputSchema.parse({ orderId: "111-2345678-9012345" });

    await expect(getOrderDescriptor.handler(ctx, input)).resolves.toEqual({ order });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "spapi");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/spapi/_query.py"),
        request: { version: "1", op: "getOrder", orderId: "111-2345678-9012345" },
        envFromSecrets: expect.objectContaining({
          SPAPI_REGION: "na",
          SPAPI_MARKETPLACE_ID: "ATVPDKIKX0DER",
        }),
        timeoutMs: 30_000,
      }),
    );
  });

  it("surfaces NotFound from the helper error envelope", async () => {
    mocks.runPythonHelper.mockRejectedValue(new NotFound("no order with id '111-9999999-9999999'"));
    const input = getOrderDescriptor.inputSchema.parse({ orderId: "111-9999999-9999999" });

    await expect(getOrderDescriptor.handler(ctx, input)).rejects.toThrow(NotFound);
  });

  it("rejects malformed orderId at input validation", () => {
    expect(() => getOrderDescriptor.inputSchema.parse({ orderId: "not-an-amazon-id" })).toThrow();
    expect(() => getOrderDescriptor.inputSchema.parse({ orderId: "111-12345-9012345" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });
});
