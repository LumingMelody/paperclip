import { z } from "zod";

export const lingxingSecretSchema = z
  .object({
    host: z.string().min(1),
    port: z.string().regex(/^\d+$/).optional(),
    user: z.string().min(1),
    password: z.string(),
    database: z.string().min(1),
  })
  .strict();

export const toolCallsSecretSchema = z.object({}).strict();

export const shopifySecretSchema = z
  .object({
    shop: z.string().regex(/^[a-z0-9-]+$/, "shop must be the subdomain (without .myshopify.com)"),
    token: z.string().min(20),
    apiVersion: z.string().regex(/^\d{4}-\d{2}$/).default("2024-10"),
  })
  .strict();

export const sourceSecretSchemas = {
  lingxing: lingxingSecretSchema,
  shopify: shopifySecretSchema,
  toolCalls: toolCallsSecretSchema,
} as const;

export type SourceWithSchema = keyof typeof sourceSecretSchemas;
