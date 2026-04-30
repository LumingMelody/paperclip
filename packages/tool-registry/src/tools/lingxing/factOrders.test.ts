import { describe, expect, it, vi } from "vitest";
import { UpstreamError, ValidationError } from "../../errors.js";
import { recordToolCall } from "../../telemetry.js";
import { queryLingxing } from "./client.js";

vi.mock("../../telemetry.js", () => ({
  recordToolCall: vi.fn(async () => undefined),
}));

vi.mock("./client.js", () => ({
  queryLingxing: vi.fn(),
}));

const { factOrders } = await import("./factOrders.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "lingxing.factOrders",
  argsHash: "b".repeat(64),
} as const;

const rows = [
  {
    skuId: "EE00001-US12",
    asin: "B01N9G3JK7",
    startDate: "2026-04-01",
    endDate: "2026-04-01",
    orderQty: 2,
    gmvLocal: 32,
    returnCount: 0,
    orderItems: 2,
    avgSellingPrice: 16,
    adSpendLocal: 4,
    adSalesAmount: 20,
  },
];

describe("factOrders", () => {
  it("validates input, queries Lingxing, and returns aggregated order rows", async () => {
    vi.mocked(queryLingxing).mockResolvedValue({ rows });
    vi.mocked(recordToolCall).mockClear();

    await expect(factOrders(ctx, { skuId: "EE00001-US12", since: "2026-04-01" })).resolves.toEqual(rows);

    expect(queryLingxing).toHaveBeenCalledWith("company-1", {
      op: "factOrders",
      skuId: "EE00001-US12",
      since: "2026-04-01",
    });
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("throws ValidationError for invalid dates", async () => {
    vi.mocked(queryLingxing).mockClear();

    await expect(factOrders(ctx, { skuId: "EE00001-US12", since: "not-a-date" })).rejects.toThrow(ValidationError);

    expect(queryLingxing).not.toHaveBeenCalled();
  });

  it("surfaces UpstreamError from the client", async () => {
    vi.mocked(queryLingxing).mockRejectedValue(new UpstreamError("database unavailable"));

    await expect(factOrders(ctx, { skuId: "EE00001-US12", since: "2026-04-01" })).rejects.toThrow(UpstreamError);
  });
});
