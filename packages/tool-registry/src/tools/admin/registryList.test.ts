import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDescriptor } from "../../registry.js";
import { makeRegistryListDescriptor } from "./registryList.js";

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "registry.list",
  argsHash: "i".repeat(64),
} as const;

function fixture(): ToolDescriptor[] {
  const noopHandler = async () => ({});
  return [
    {
      id: "lingxing.factSku",
      source: "lingxing",
      cliSubcommand: "fact-sku",
      description: "Fetch master SKU row by ASIN.",
      readOnly: true,
      inputSchema: z.object({ asin: z.string() }),
      requiredSecrets: ["host", "user", "password"],
      handler: noopHandler,
    } as ToolDescriptor,
    {
      id: "shopify.getProduct",
      source: "shopify",
      cliSubcommand: "get-product",
      description: "Fetch a Shopify product by handle.",
      readOnly: true,
      inputSchema: z
        .object({
          handle: z.string(),
        })
        .strict(),
      requiredSecrets: ["shop", "token"],
      handler: noopHandler,
    } as ToolDescriptor,
    {
      id: "meta.adsetPerformance",
      source: "meta",
      cliSubcommand: "adset-performance",
      description: "Adset insights for a date range.",
      readOnly: true,
      inputSchema: z
        .object({
          accountId: z.string(),
          since: z.string(),
          until: z.string(),
        })
        .strict()
        .refine((v) => v.since <= v.until, { message: "since must be <= until" }),
      requiredSecrets: ["accessToken"],
      handler: noopHandler,
    } as ToolDescriptor,
  ];
}

describe("registry.list", () => {
  it("returns all registered tools sorted by id", async () => {
    const desc = makeRegistryListDescriptor({ registry: fixture() });
    const out = await desc.handler(ctx, {});
    expect(out.total).toBe(3);
    expect(out.tools.map((t) => t.id)).toEqual([
      "lingxing.factSku",
      "meta.adsetPerformance",
      "shopify.getProduct",
    ]);
  });

  it("filters by exact source name", async () => {
    const desc = makeRegistryListDescriptor({ registry: fixture() });
    const out = await desc.handler(ctx, { source: "shopify" });
    expect(out.total).toBe(1);
    expect(out.tools[0].id).toBe("shopify.getProduct");
  });

  it("filters by case-insensitive grep over id and description", async () => {
    const desc = makeRegistryListDescriptor({ registry: fixture() });
    const out = await desc.handler(ctx, { grep: "ADSET" });
    expect(out.total).toBe(1);
    expect(out.tools[0].id).toBe("meta.adsetPerformance");
  });

  it("returns empty when nothing matches", async () => {
    const desc = makeRegistryListDescriptor({ registry: fixture() });
    const out = await desc.handler(ctx, { source: "spapi" });
    expect(out.total).toBe(0);
    expect(out.tools).toEqual([]);
  });

  it("describes input fields including those behind ZodEffects (.refine)", async () => {
    const desc = makeRegistryListDescriptor({ registry: fixture() });
    const out = await desc.handler(ctx, { source: "meta" });
    expect(out.tools[0].inputFields).toEqual(["accountId", "since", "until"]);
  });

  it("includes requiredSecrets, defaulting to empty array when undefined", async () => {
    const desc = makeRegistryListDescriptor({
      registry: [
        {
          id: "x.y",
          source: "x",
          cliSubcommand: "y",
          description: "no-secrets tool",
          readOnly: true,
          inputSchema: z.object({}),
          handler: async () => ({}),
        } as ToolDescriptor,
      ],
    });
    const out = await desc.handler(ctx, {});
    expect(out.tools[0].requiredSecrets).toEqual([]);
  });
});
