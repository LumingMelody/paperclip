import { describe, expect, it } from "vitest";
import { dwsHelperResponseSchema } from "./client.js";

// Regression: the shared dws helper-response envelope must NOT be `.strict()`.
// A strict envelope rejected top-level metadata that tools legitimately attach
// (returnRateByStyle: asOfDate / windowStart / windowEnd / maturityDays /
// windowIncludesImmature), surfacing as
//   UpstreamError: "python helper returned an unexpected response shape:
//   Unrecognized key(s) in object: 'asOfDate', ..."
// which only manifested on the real CLI/subprocess path (mocked unit tests and
// direct _query.py runs both bypass this envelope).
describe("dwsHelperResponseSchema", () => {
  it("accepts top-level metadata alongside rows (passthrough, not strict)", () => {
    const parsed = dwsHelperResponseSchema.parse({
      version: "1",
      rows: [{ styleCode: "EE02401", salesQty: 18, returnQty: 16, returnRate: 0.8889, skuCount: 17 }],
      asOfDate: "2026-06-02",
      windowStart: "2026-04-01",
      windowEnd: "2026-05-01",
      maturityDays: 45,
      windowIncludesImmature: true,
    });
    expect(parsed.rows).toHaveLength(1);
    // passthrough preserves the metadata so queryDws hands it to the descriptor
    expect((parsed as Record<string, unknown>).windowEnd).toBe("2026-05-01");
    expect((parsed as Record<string, unknown>).maturityDays).toBe(45);
  });

  it("still requires version === '1' and a rows array", () => {
    expect(() => dwsHelperResponseSchema.parse({ version: "2", rows: [] })).toThrow();
    expect(() => dwsHelperResponseSchema.parse({ version: "1" })).toThrow();
  });
});
