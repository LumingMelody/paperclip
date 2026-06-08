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

const { salesSummaryDescriptor } = await import("./salesSummary.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.salesSummary",
  argsHash: "c".repeat(64),
} as const;

const metadata = {
  asOfDate: "2026-06-04",
  windowStart: "2026-05-01",
  windowEnd: null,
  coveredThrough: null,
};

describe("dws.salesSummary", () => {
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

  it("queries canonical company-wide sales summary through the python helper and returns rows", async () => {
    const rows = [
      {
        groupKey: "Amazon",
        currency: "USD",
        gmv: 12345.6789,
        units: 321,
        orderCount: 250,
        refundAmount: 123.4567,
        refundRate: 0.048,
        netSales: 12222.2222,
      },
      {
        groupKey: "Shopify",
        currency: "GBP",
        gmv: 9876.5432,
        units: 210,
        orderCount: 175,
        refundAmount: 0,
        refundRate: null,
        netSales: 9876.5432,
      },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows, ...metadata });
    const input = salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01" });

    const output = await salesSummaryDescriptor.handler(ctx, input);
    expect(output).toEqual({ rows, ...metadata });
    expect(output.rows.map((row) => row.currency)).toEqual(["USD", "GBP"]);

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "dws");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/dws/_query.py"),
        request: {
          version: "1",
          op: "salesSummary",
          since: "2026-05-01",
          until: undefined,
          groupBy: "platform",
          platform: undefined,
          account: undefined,
          style: undefined,
          top: undefined,
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

  it("forwards explicit until / groupBy / platform / top overrides to the helper", async () => {
    const rows = [
      {
        groupKey: "2026-05",
        currency: "USD",
        gmv: 12345.6789,
        units: 321,
        orderCount: 250,
        refundAmount: 123.4567,
        refundRate: 0.048,
        netSales: 12222.2222,
      },
    ];
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows,
      ...metadata,
      windowEnd: "2026-06-01",
      coveredThrough: "2026-05-31",
    });
    const input = salesSummaryDescriptor.inputSchema.parse({
      since: "2026-05-01",
      until: "2026-06-01",
      groupBy: "month",
      platform: "Amazon",
      top: 5,
    });

    await expect(salesSummaryDescriptor.handler(ctx, input)).resolves.toEqual({
      rows,
      ...metadata,
      windowEnd: "2026-06-01",
      coveredThrough: "2026-05-31",
    });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "salesSummary",
          since: "2026-05-01",
          until: "2026-06-01",
          groupBy: "month",
          platform: "Amazon",
          account: undefined,
          style: undefined,
          top: 5,
        },
      }),
    );
  });

  it("forwards style and account filters with style grouping to the helper", async () => {
    const rows = [
      {
        groupKey: "EG02778",
        currency: "USD",
        gmv: 1234.56,
        units: 42,
        orderCount: 35,
        refundAmount: 34.56,
        refundRate: 0.057143,
        netSales: 1200,
      },
    ];
    mocks.runPythonHelper.mockResolvedValue({
      version: "1",
      rows,
      ...metadata,
      windowEnd: "2026-06-01",
      coveredThrough: "2026-05-31",
    });
    const input = salesSummaryDescriptor.inputSchema.parse({
      since: "2026-05-01",
      until: "2026-06-01",
      groupBy: "style",
      account: "AmazonEPUS",
      style: "EG02778",
      top: 10,
    });

    await expect(salesSummaryDescriptor.handler(ctx, input)).resolves.toEqual({
      rows,
      ...metadata,
      windowEnd: "2026-06-01",
      coveredThrough: "2026-05-31",
    });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "salesSummary",
          since: "2026-05-01",
          until: "2026-06-01",
          groupBy: "style",
          platform: undefined,
          account: "AmazonEPUS",
          style: "EG02778",
          top: 10,
        },
      }),
    );
  });

  it("rejects malformed dates at input validation", () => {
    expect(() => salesSummaryDescriptor.inputSchema.parse({ since: "2026/05/01" })).toThrow();
    expect(() =>
      salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01", until: "June 1 2026" }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects invalid groupBy and top values at input validation", () => {
    expect(() => salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01", groupBy: "sku" })).toThrow();
    expect(() => salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01", top: 0 })).toThrow();
    expect(() => salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01", top: 201 })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("accepts valid inputs with optional fields omitted and groupBy none", () => {
    expect(() => salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01" })).not.toThrow();
    expect(() => salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01", groupBy: "none" })).not.toThrow();
    expect(() => salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01", groupBy: "style" })).not.toThrow();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [{ groupKey: "Amazon" }], ...metadata });
    const input = salesSummaryDescriptor.inputSchema.parse({ since: "2026-05-01" });

    await expect(salesSummaryDescriptor.handler(ctx, input)).rejects.toThrow();
  });
});
