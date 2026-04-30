import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SecretsNotConfigured } from "./errors.js";

const rawSecretValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const sourceSecretsSchema = z.record(rawSecretValueSchema);
const companySecretsSchema = z.record(sourceSecretsSchema);
const toolSecretsFileSchema = z.object({
  companies: z.record(companySecretsSchema),
});

export function toolSecretsPath(): string {
  return path.join(os.homedir(), ".paperclip", "tool-secrets.json");
}

export async function loadCompanySecrets(companyId: string, source: string): Promise<Record<string, string>> {
  const filePath = toolSecretsPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
    if (code === "ENOENT") {
      throw new SecretsNotConfigured(`Tool secrets are not configured at ${filePath}`);
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new SecretsNotConfigured(`Tool secrets file is not valid JSON: ${filePath}`);
  }

  const parsed = toolSecretsFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new SecretsNotConfigured(`Tool secrets file has an invalid schema: ${filePath}`);
  }

  const companySecrets = parsed.data.companies[companyId];
  if (!companySecrets) {
    throw new SecretsNotConfigured(`No tool credentials configured for company ${companyId}`);
  }

  const sourceSecrets = companySecrets[source];
  if (!sourceSecrets) {
    throw new SecretsNotConfigured(`No ${source} credentials configured for company ${companyId}`);
  }

  return Object.fromEntries(Object.entries(sourceSecrets).map(([key, value]) => [key, String(value)]));
}
