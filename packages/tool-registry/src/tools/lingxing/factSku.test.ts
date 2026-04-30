import { describe, expect, it, vi } from "vitest";
import { NotFound, UpstreamError, ValidationError } from "../../errors.js";
import { recordToolCall } from "../../telemetry.js";
import { queryLingxing } from "./client.js";

vi.mock("../../telemetry.js", () => ({
  recordToolCall: vi.fn(async () => undefined),
}));

vi.mock("./client.js", () => ({
  queryLingxing: vi.fn(),
}));

const { factSku } = await import("./factSku.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "lingxing.factSku",
  argsHash: "a".repeat(64),
} as const;

const row = {
  asin: "B01N9G3JK7",
  parentAsin: "B01PARENT1",
  sellerSku: "EE00001-US12",
  productTitle: "Dress",
  shopSid: 13087,
  shopName: "EP-US",
  currencyCode: "USD",
  firstSeen: "2026-01-01",
  lastSeen: "2026-04-30",
  orderQty: 10,
  gmvLocal: 120.5,
  returnCount: 1,
  avgRating: 4.5,
  reviewsCount: 20,
};

describe("factSku", () => {
  it("validates input, queries Lingxing, and returns one SKU row", async () => {
    vi.mocked(queryLingxing).mockResolvedValue({ row });
    vi.mocked(recordToolCall).mockClear();

    await expect(factSku(ctx, { asin: "B01N9G3JK7" })).resolves.toEqual(row);

    expect(queryLingxing).toHaveBeenCalledWith("company-1", {
      op: "factSku",
      asin: "B01N9G3JK7",
    });
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("throws ValidationError without calling the client for malformed ASINs", async () => {
    vi.mocked(queryLingxing).mockClear();

    await expect(factSku(ctx, { asin: "bad" })).rejects.toThrow(ValidationError);

    expect(queryLingxing).not.toHaveBeenCalled();
  });

  it("throws NotFound when Lingxing returns no row", async () => {
    vi.mocked(queryLingxing).mockResolvedValue({ row: null });

    await expect(factSku(ctx, { asin: "B01N9G3JK7" })).rejects.toThrow(NotFound);
  });

  it("surfaces UpstreamError from the client", async () => {
    vi.mocked(queryLingxing).mockRejectedValue(new UpstreamError("database unavailable"));

    await expect(factSku(ctx, { asin: "B01N9G3JK7" })).rejects.toThrow(UpstreamError);
  });
});
