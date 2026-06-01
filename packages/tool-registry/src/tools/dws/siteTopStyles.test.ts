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

const { siteTopStylesDescriptor } = await import("./siteTopStyles.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.siteTopStyles",
  argsHash: "c".repeat(64),
} as const;

describe("dws.siteTopStyles", () => {
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

  it("queries DWS for a site through the python helper and returns the parsed rows", async () => {
    const rows = [
      { styleCode: "EP1234", salesQty: 412, skuCount: 9, productTitle: "Long Evening Gown" },
      { styleCode: "EP5678", salesQty: 207, skuCount: 5, productTitle: null },
      { styleCode: null, salesQty: 33, skuCount: 1, productTitle: "Misc" },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows });
    const input = siteTopStylesDescriptor.inputSchema.parse({
      site: "US",
      since: "2026-01-01",
      top: 10,
    });

    await expect(siteTopStylesDescriptor.handler(ctx, input)).resolves.toEqual({ rows });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "dws");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/dws/_query.py"),
        request: {
          version: "1",
          op: "siteTopStyles",
          account: "EPSITEUS",
          since: "2026-01-01",
          top: 10,
          style: undefined,
        },
        envFromSecrets: {
          DWS_DB_HOST: "dws-test-host",
          DWS_DB_PORT: "3306",
          DWS_DB_USER: "dws_user",
          DWS_DB_PASSWORD: "dws_password",
          DWS_DB_DATABASE: "dws_db",
        },
      }),
    );
  });

  it("defaults top to 20 and forwards a style filter when provided", async () => {
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows: [{ styleCode: "EP1234", salesQty: 412, skuCount: 9, productTitle: "Long Evening Gown" }],
    });
    const input = siteTopStylesDescriptor.inputSchema.parse({
      site: "UK",
      since: "2026-03-15",
      style: "EP1234",
    });

    await siteTopStylesDescriptor.handler(ctx, input);

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "siteTopStyles",
          account: "EPSITEUK",
          since: "2026-03-15",
          top: 20,
          style: "EP1234",
        },
      }),
    );
  });

  it("accepts a valid input at input validation", () => {
    expect(() =>
      siteTopStylesDescriptor.inputSchema.parse({ site: "FR", since: "2026-02-28" }),
    ).not.toThrow();
  });

  it("rejects an unknown site at input validation", () => {
    expect(() =>
      siteTopStylesDescriptor.inputSchema.parse({ site: "JP", since: "2026-01-01" }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects a malformed since date at input validation", () => {
    expect(() =>
      siteTopStylesDescriptor.inputSchema.parse({ site: "US", since: "01/01/2026" }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects unknown keys (strict schema)", () => {
    expect(() =>
      siteTopStylesDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01", foo: "bar" }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows: [{ styleCode: "EP1234" }],
    });
    const input = siteTopStylesDescriptor.inputSchema.parse({ site: "US", since: "2026-01-01" });

    await expect(siteTopStylesDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
