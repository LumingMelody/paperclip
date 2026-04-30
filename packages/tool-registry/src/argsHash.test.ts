import { describe, expect, it } from "vitest";
import { canonicalJson, hashArgs } from "./argsHash.js";

describe("hashArgs", () => {
  it("hashes equivalent objects identically regardless of key order", () => {
    const first = hashArgs({ z: 1, a: { c: 3, b: 2 } });
    const second = hashArgs({ a: { b: 2, c: 3 }, z: 1 });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts sensitive keys before canonicalizing", () => {
    const canonical = canonicalJson({
      asin: "B01N9G3JK7",
      nested: {
        authToken: "secret-token-value",
        apiKey: "key-value",
      },
    });

    expect(canonical).not.toContain("secret-token-value");
    expect(canonical).not.toContain("key-value");
    expect(canonical).toContain("[REDACTED]");
  });
});
