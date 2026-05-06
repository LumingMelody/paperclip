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

export const decisionsSecretSchema = z.object({}).strict();

export const registrySecretSchema = z.object({}).strict();

export const briefsSecretSchema = z.object({}).strict();

export const shopifySecretSchema = z
  .object({
    shop: z.string().regex(/^[a-z0-9-]+$/, "shop must be the subdomain (without .myshopify.com)"),
    token: z.string().min(20),
    apiVersion: z.string().regex(/^\d{4}-\d{2}$/).default("2024-10"),
  })
  .strict();

export const metaSecretSchema = z
  .object({
    accessToken: z.string().min(20),
    apiVersion: z.string().regex(/^v\d+\.\d+$/).default("v20.0"),
  })
  .strict();

export const spapiSecretSchema = z
  .object({
    refreshToken: z.string().min(20),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    region: z.enum(["na", "eu", "fe"]).default("na"),
    marketplaceId: z.string().regex(/^[A-Z0-9]+$/).default("ATVPDKIKX0DER"),
  })
  .strict();

export const sourceSecretSchemas = {
  lingxing: lingxingSecretSchema,
  shopify: shopifySecretSchema,
  meta: metaSecretSchema,
  spapi: spapiSecretSchema,
  toolCalls: toolCallsSecretSchema,
  decisions: decisionsSecretSchema,
  registry: registrySecretSchema,
  briefs: briefsSecretSchema,
} as const;

export type SourceWithSchema = keyof typeof sourceSecretSchemas;
