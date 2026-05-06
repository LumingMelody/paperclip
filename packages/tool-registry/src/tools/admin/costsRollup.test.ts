import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "../../telemetry.js";
import { aggregate } from "./costsRollup.js";

function entry(overrides: Partial<ToolCallEntry>): ToolCallEntry {
  return {
    ts: "2026-04-29T12:00:00.000Z",
    company: "company-1",
    project: "project-1",
    issue: "CRO-37",
    tool: "lingxing.factSku",
    argsHash: "a".repeat(64),
    status: "success",
    durationMs: 100,
    costUnits: 1,
    ...overrides,
  } as ToolCallEntry;
}

describe("costs.rollup aggregate()", () => {
  const FIXTURE: ToolCallEntry[] = [
    entry({ ts: "2026-04-28T10:00:00Z", tool: "lingxing.factSku", durationMs: 100, costUnits: 1, issue: "CRO-37" }),
    entry({ ts: "2026-04-28T10:01:00Z", tool: "lingxing.factSku", durationMs: 200, costUnits: 1, issue: "CRO-37" }),
    entry({ ts: "2026-04-28T10:02:00Z", tool: "lingxing.factOrders", durationMs: 800, costUnits: 1, issue: "CRO-38" }),
    entry({ ts: "2026-04-29T11:00:00Z", tool: "shopify.getProduct", durationMs: 50, costUnits: 1, issue: "CRO-37", status: "error" }),
    entry({ ts: "2026-04-29T11:30:00Z", tool: "shopify.getProduct", durationMs: 75, costUnits: 1, issue: "CRO-37" }),
  ];

  it("groups by tool by default and sorts by totalDurationMs desc", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28" });
    expect(out.by).toBe("tool");
    expect(out.groups.map((g) => g.key)).toEqual([
      "lingxing.factOrders",  // 800
      "lingxing.factSku",     // 100+200=300
      "shopify.getProduct",   // 50+75=125
    ]);
    expect(out.totalCalls).toBe(5);
    expect(out.totalErrorCalls).toBe(1);
    expect(out.totalDurationMs).toBe(1225);
    expect(out.totalCostUnits).toBe(5);
  });

  it("computes count, errorCount, p50/p95 per group", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28", by: "tool" });
    const shopify = out.groups.find((g) => g.key === "shopify.getProduct")!;
    expect(shopify.count).toBe(2);
    expect(shopify.errorCount).toBe(1);
    expect(shopify.totalDurationMs).toBe(125);
    // sorted: [50, 75]; p50 picks index 0 (50), p95 picks index 1 (75)
    expect(shopify.p50DurationMs).toBe(50);
    expect(shopify.p95DurationMs).toBe(75);
  });

  it("groups by issue when by=issue", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28", by: "issue" });
    expect(out.groups.map((g) => g.key)).toEqual(["CRO-37", "CRO-38"].sort((a, b) => {
      // expected order is by totalDurationMs desc; CRO-37 = 425, CRO-38 = 800 → 38 first
      const totals: Record<string, number> = { "CRO-37": 425, "CRO-38": 800 };
      return totals[b] - totals[a];
    }));
    expect(out.groups[0].key).toBe("CRO-38");
    expect(out.groups[0].totalDurationMs).toBe(800);
    expect(out.groups[1].key).toBe("CRO-37");
    expect(out.groups[1].totalDurationMs).toBe(425);
  });

  it("groups by day (UTC)", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28", by: "day" });
    expect(out.groups.map((g) => g.key).sort()).toEqual(["2026-04-28", "2026-04-29"]);
  });

  it("groups by status", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28", by: "status" });
    const success = out.groups.find((g) => g.key === "success")!;
    const error = out.groups.find((g) => g.key === "error")!;
    expect(success.count).toBe(4);
    expect(error.count).toBe(1);
    expect(error.errorCount).toBe(1);
  });

  it("respects since cut-off", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-29" });
    expect(out.totalCalls).toBe(2); // only the two shopify calls on 04-29
  });

  it("respects until cut-off", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28", until: "2026-04-28T23:59:59Z" });
    expect(out.totalCalls).toBe(3); // three lingxing calls only
  });

  it("filters by tool", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28", tool: "shopify.getProduct" });
    expect(out.totalCalls).toBe(2);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].key).toBe("shopify.getProduct");
  });

  it("filters by issue", () => {
    const out = aggregate(FIXTURE, { since: "2026-04-28", issue: "CRO-38" });
    expect(out.totalCalls).toBe(1);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].key).toBe("lingxing.factOrders");
  });

  it("returns empty roll-up when no entries match", () => {
    const out = aggregate(FIXTURE, { since: "2027-01-01" });
    expect(out.totalCalls).toBe(0);
    expect(out.groups).toEqual([]);
    expect(out.totalDurationMs).toBe(0);
  });

  it("treats missing costUnits as 0", () => {
    const noCost = [entry({ ts: "2026-04-28T10:00:00Z", costUnits: undefined as unknown as number })];
    const out = aggregate(noCost, { since: "2026-04-28" });
    expect(out.totalCostUnits).toBe(0);
    expect(out.groups[0].totalCostUnits).toBe(0);
  });
});
