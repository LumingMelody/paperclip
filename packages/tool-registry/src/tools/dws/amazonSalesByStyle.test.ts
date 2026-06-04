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

const { amazonSalesByStyleDescriptor } = await import("./amazonSalesByStyle.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.amazonSalesByStyle",
  argsHash: "c".repeat(64),
} as const;

const metadata = {
  asOfDate: "2026-06-04",
  windowStart: "2026-05-01",
  windowEnd: null,
  coveredThrough: null,
};

describe("dws.amazonSalesByStyle", () => {
  beforeEach(() => {
    mocks.loadCompanySecrets.mockReset();
    mocks.runPythonHelper.mockReset();
    mocks.loadCompanySecrets.mockResolvedValue({
      host: "dws-test.example.com",
      port: "3306",
      user: "dws_reader",
      password: "dws_secret_pw",
      database: "dws_warehouse",
    });
  });

  it("queries fresh Amazon sales by shop/since through the python helper and returns rows", async () => {
    const rows = [
      {
        styleCode: "EG02778",
        salesQty: 65,
        orderCount: 61,
        skuCount: 8,
        firstSaleDate: "2026-05-01",
        lastSaleDate: "2026-06-04",
      },
      {
        styleCode: "EE02559",
        salesQty: 42,
        orderCount: 39,
        skuCount: 6,
        firstSaleDate: "2026-05-02",
        lastSaleDate: "2026-06-03",
      },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows, ...metadata });
    const input = amazonSalesByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-05-01" });

    await expect(amazonSalesByStyleDescriptor.handler(ctx, input)).resolves.toEqual({ rows, ...metadata });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "dws");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/dws/_query.py"),
        request: {
          version: "1",
          op: "amazonSalesByStyle",
          account: "AmazonEPUS",
          since: "2026-05-01",
          until: undefined,
          top: 20,
          style: undefined,
        },
        envFromSecrets: {
          DWS_DB_HOST: "dws-test.example.com",
          DWS_DB_PORT: "3306",
          DWS_DB_USER: "dws_reader",
          DWS_DB_PASSWORD: "dws_secret_pw",
          DWS_DB_DATABASE: "dws_warehouse",
        },
      }),
    );
  });

  it("forwards explicit until / top / style overrides to the helper", async () => {
    const rows = [
      {
        styleCode: "EG02778",
        salesQty: 65,
        orderCount: 61,
        skuCount: 8,
        firstSaleDate: "2026-05-01",
        lastSaleDate: "2026-05-31",
      },
    ];
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows,
      ...metadata,
      windowEnd: "2026-06-01",
      coveredThrough: "2026-05-31",
    });
    const input = amazonSalesByStyleDescriptor.inputSchema.parse({
      shop: "PZ-UK",
      since: "2026-05-01",
      until: "2026-06-01",
      top: 5,
      style: "EG02778",
    });

    await expect(amazonSalesByStyleDescriptor.handler(ctx, input)).resolves.toEqual({
      rows,
      ...metadata,
      windowEnd: "2026-06-01",
      coveredThrough: "2026-05-31",
    });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "amazonSalesByStyle",
          account: "AmazonPZUK",
          since: "2026-05-01",
          until: "2026-06-01",
          top: 5,
          style: "EG02778",
        },
      }),
    );
  });

  it("rejects malformed shop codes at input validation", () => {
    expect(() => amazonSalesByStyleDescriptor.inputSchema.parse({ shop: "ep-us", since: "2026-05-01" })).toThrow();
    expect(() => amazonSalesByStyleDescriptor.inputSchema.parse({ shop: "XX-US", since: "2026-05-01" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects malformed since and until dates at input validation", () => {
    expect(() => amazonSalesByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026/05/01" })).toThrow();
    expect(() =>
      amazonSalesByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-05-01", until: "June 1 2026" }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("accepts a valid input with optional fields omitted", () => {
    expect(() => amazonSalesByStyleDescriptor.inputSchema.parse({ shop: "DAMA-US", since: "2026-05-01" })).not.toThrow();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [{ styleCode: "EG02778" }], ...metadata });
    const input = amazonSalesByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-05-01" });

    await expect(amazonSalesByStyleDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
