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

const { listOrdersUpdatedSinceDescriptor } = await import("./listOrdersUpdatedSince.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "spapi.listOrdersUpdatedSince",
  argsHash: "g".repeat(64),
} as const;

describe("spapi.listOrdersUpdatedSince", () => {
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

  it("forwards since + marketplaceId to the helper", async () => {
    const orders = [
      { AmazonOrderId: "111-1", LastUpdateDate: "2026-04-29T00:00:00Z" },
      { AmazonOrderId: "111-2", LastUpdateDate: "2026-04-28T00:00:00Z" },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", orders, nextToken: null });
    const input = listOrdersUpdatedSinceDescriptor.inputSchema.parse({
      since: "2026-04-01T00:00:00Z",
      marketplaceId: "ATVPDKIKX0DER",
      maxResults: 50,
    });

    await expect(listOrdersUpdatedSinceDescriptor.handler(ctx, input)).resolves.toEqual({
      orders,
      nextToken: null,
    });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "listOrdersUpdatedSince",
          since: "2026-04-01T00:00:00Z",
          marketplaceId: "ATVPDKIKX0DER",
          maxResults: 50,
        },
      }),
    );
  });

  it("allows omitting marketplaceId (helper falls back to env)", () => {
    expect(() =>
      listOrdersUpdatedSinceDescriptor.inputSchema.parse({ since: "2026-04-01T00:00:00Z" }),
    ).not.toThrow();
  });

  it("rejects non-ISO since", () => {
    expect(() =>
      listOrdersUpdatedSinceDescriptor.inputSchema.parse({ since: "2026-04-01" }),
    ).toThrow();
    expect(() =>
      listOrdersUpdatedSinceDescriptor.inputSchema.parse({ since: "yesterday" }),
    ).toThrow();
  });

  it("rejects maxResults out of range", () => {
    expect(() =>
      listOrdersUpdatedSinceDescriptor.inputSchema.parse({
        since: "2026-04-01T00:00:00Z",
        maxResults: 200,
      }),
    ).toThrow();
    expect(() =>
      listOrdersUpdatedSinceDescriptor.inputSchema.parse({
        since: "2026-04-01T00:00:00Z",
        maxResults: 0,
      }),
    ).toThrow();
  });

  it("validates output rows is an array", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", orders: "not-array" });
    const input = listOrdersUpdatedSinceDescriptor.inputSchema.parse({
      since: "2026-04-01T00:00:00Z",
      marketplaceId: "ATVPDKIKX0DER",
    });

    await expect(listOrdersUpdatedSinceDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
