import { describe, expect, it, vi } from "vitest";
import { NotFound, ValidationError } from "../../errors.js";
import { recordToolCall } from "../../telemetry.js";
import { queryLingxing } from "./client.js";

vi.mock("../../telemetry.js", () => ({
  recordToolCall: vi.fn(async () => undefined),
}));

vi.mock("./client.js", () => ({
  queryLingxing: vi.fn(),
}));

const { styleSummary } = await import("./styleSummary.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "lingxing.styleSummary",
  argsHash: "c".repeat(64),
} as const;

const row = {
  orderQty: 30,
  returnCount: 3,
  returnRate: 0.1,
  gmvLocal: 450.75,
  variantCount: 2,
  asinCount: 2,
  firstSeen: "2026-04-01",
  lastSeen: "2026-05-01",
  asins: ["B01N9G3JK7", "B01PARENT1"],
  variants: [
    {
      sku: "EE02559-Navy-M",
      asin: "B01N9G3JK7",
      orderQty: 20,
      returnCount: 2,
      returnRate: 0.1,
    },
    {
      sku: "EE02559-Black-XL",
      asin: "B01PARENT1",
      orderQty: 10,
      returnCount: 1,
      returnRate: 0.1,
    },
  ],
};

describe("styleSummary", () => {
  it("validates input, queries Lingxing, and returns a style summary", async () => {
    vi.mocked(queryLingxing).mockResolvedValue({ row });
    vi.mocked(recordToolCall).mockClear();

    await expect(
      styleSummary(ctx, { stylePrefix: "EE02559", shop: "EP-US", since: "2026-04-01" }),
    ).resolves.toEqual(row);

    expect(queryLingxing).toHaveBeenCalledWith("company-1", {
      op: "styleSummary",
      stylePrefix: "EE02559",
      shop: "EP-US",
      since: "2026-04-01",
    });
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("throws NotFound when Lingxing returns no matching style rows", async () => {
    vi.mocked(queryLingxing).mockResolvedValue({ row: null });

    await expect(styleSummary(ctx, { stylePrefix: "EE02559", shop: "EP-US", since: "2026-04-01" })).rejects.toThrow(
      NotFound,
    );
  });

  it("throws ValidationError without calling the client when required input is missing", async () => {
    vi.mocked(queryLingxing).mockClear();

    await expect(styleSummary(ctx, { shop: "EP-US", since: "2026-04-01" })).rejects.toThrow(ValidationError);

    expect(queryLingxing).not.toHaveBeenCalled();
  });
});
