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

const { returnRateByStyleDescriptor } = await import("./returnRateByStyle.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "dws.returnRateByStyle",
  argsHash: "c".repeat(64),
} as const;

const metadata = {
  asOfDate: "2026-06-02",
  windowStart: "2026-01",
  windowEnd: "2026-05",
  coveredThrough: "2026-04",
  maturityDays: 45,
  windowIncludesImmature: false,
};

describe("dws.returnRateByStyle", () => {
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

  it("documents sale-month cohorts without check_date wording", () => {
    expect(returnRateByStyleDescriptor.description).toContain("sale-month cohort");
    expect(returnRateByStyleDescriptor.description).toContain("dws_od_amazon_refund_rate_d.yearmouth");
    expect(returnRateByStyleDescriptor.description).not.toContain("check_date");
  });

  it("queries DWS by shop/since through the python helper and returns the rows", async () => {
    const rows = [
      { styleCode: "AB12345", salesQty: 1200, returnQty: 96, returnRate: 0.08, skuCount: 14 },
      { styleCode: "CD67890", salesQty: 800, returnQty: 40, returnRate: 0.05, skuCount: 9 },
    ];
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows, ...metadata });
    const input = returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-01-01" });

    await expect(returnRateByStyleDescriptor.handler(ctx, input)).resolves.toEqual({ rows, ...metadata });

    expect(mocks.loadCompanySecrets).toHaveBeenCalledWith("company-1", "dws");
    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        helperPath: expect.stringContaining("/tools/dws/_query.py"),
        request: {
          version: "1",
          op: "returnRateByStyle",
          account: "AmazonEPUS",
          since: "2026-01-01",
          until: undefined,
          top: 20,
          minQty: 50,
          maturityDays: 45,
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

  it("forwards explicit until / maturityDays / top / minQty / style overrides to the helper", async () => {
    const explicitMetadata = {
      ...metadata,
      windowStart: "2025-12",
      windowEnd: "2026-05",
      coveredThrough: "2026-04",
      maturityDays: 30,
      windowIncludesImmature: false,
    };
    mocks.runPythonHelper.mockResolvedValue({ version: "1", rows: [], ...explicitMetadata });
    const input = returnRateByStyleDescriptor.inputSchema.parse({
      shop: "PZ-UK",
      since: "2025-12-31",
      until: "2026-05-01",
      top: 5,
      minQty: 100,
      maturityDays: 30,
      style: "AB12345",
    });

    await expect(returnRateByStyleDescriptor.handler(ctx, input)).resolves.toEqual({ rows: [], ...explicitMetadata });

    expect(mocks.runPythonHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          version: "1",
          op: "returnRateByStyle",
          account: "AmazonPZUK",
          since: "2025-12-31",
          until: "2026-05-01",
          top: 5,
          minQty: 100,
          maturityDays: 30,
          style: "AB12345",
        },
      }),
    );
  });

  it("rejects malformed shop codes at input validation", () => {
    expect(() => returnRateByStyleDescriptor.inputSchema.parse({ shop: "ep-us", since: "2026-01-01" })).toThrow();
    expect(() => returnRateByStyleDescriptor.inputSchema.parse({ shop: "XX-US", since: "2026-01-01" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects malformed since dates at input validation", () => {
    expect(() => returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026/01/01" })).toThrow();
    expect(() => returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "Jan 1 2026" })).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects malformed until dates at input validation", () => {
    expect(() =>
      returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-01-01", until: "2026/05/01" }),
    ).toThrow();
    expect(() =>
      returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-01-01", until: "May 1 2026" }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("rejects out-of-range maturityDays at input validation", () => {
    expect(() =>
      returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-01-01", maturityDays: -1 }),
    ).toThrow();
    expect(() =>
      returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-01-01", maturityDays: 181 }),
    ).toThrow();
    expect(mocks.runPythonHelper).not.toHaveBeenCalled();
  });

  it("accepts a valid input with optional fields omitted", () => {
    expect(() => returnRateByStyleDescriptor.inputSchema.parse({ shop: "DAMA-US", since: "2026-01-01" })).not.toThrow();
  });

  it("validates the helper output shape", async () => {
    mocks.runPythonHelper.mockResolvedValue({ rows: [{ styleCode: "AB12345" }] });
    const input = returnRateByStyleDescriptor.inputSchema.parse({ shop: "EP-US", since: "2026-01-01" });

    await expect(returnRateByStyleDescriptor.handler(ctx, input)).rejects.toThrow();
  });

  it("accepts sale-month maturity metadata from the helper", async () => {
    const helperOutput = {
      rows: [],
      ...metadata,
      coveredThrough: null,
      cohortBasis: "sale_month",
      requestedStartMonth: "2026-06",
      firstImmatureMonth: "2026-06",
      matureThroughMonth: null,
      allImmature: true,
    };
    mocks.runPythonHelper.mockResolvedValue({ version: "1", ...helperOutput });
    const input = returnRateByStyleDescriptor.inputSchema.parse({
      shop: "EP-US",
      since: "2026-06-01",
      until: "2026-07-01",
      maturityDays: 45,
    });

    await expect(returnRateByStyleDescriptor.handler(ctx, input)).resolves.toEqual(helperOutput);
  });
});
