import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SecretsNotConfigured } from "./errors.js";
import { sourceSecretSchemas, type SourceWithSchema } from "./secrets-schemas.js";

const rawSecretValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const sourceSecretsSchema = z.record(rawSecretValueSchema);
const companySecretsSchema = z.record(sourceSecretsSchema);
const toolSecretsFileSchema = z.object({
  companies: z.record(companySecretsSchema),
});

export function toolSecretsPath(): string {
  return path.join(os.homedir(), ".paperclip", "tool-secrets.json");
}

function formatSchemaIssuePath(pathParts: Array<string | number>): string {
  return pathParts.length > 0 ? pathParts.join(".") : "credentials";
}

function normalizeSecrets(sourceSecrets: Record<string, string | number | boolean>): Record<string, string> {
  // Strip documentation/comment keys ($comment, __hint, etc.) so users can
  // freely annotate their tool-secrets.json without tripping `.strict()`
  // schema validation. Only `__`- and `$`-prefixed keys are stripped.
  return Object.fromEntries(
    Object.entries(sourceSecrets)
      .filter(([key]) => !key.startsWith("__") && !key.startsWith("$"))
      .map(([key, value]) => [key, String(value)]),
  );
}

export async function loadCompanySecrets<S extends SourceWithSchema>(
  companyId: string,
  source: S,
): Promise<z.infer<(typeof sourceSecretSchemas)[S]>> {
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

  const fileParsed = toolSecretsFileSchema.safeParse(parsedJson);
  if (!fileParsed.success) {
    throw new SecretsNotConfigured(`Tool secrets file has an invalid schema: ${filePath}`);
  }

  const companySecrets = fileParsed.data.companies[companyId];
  if (!companySecrets) {
    throw new SecretsNotConfigured(`No tool credentials configured for company ${companyId}`);
  }

  const sourceSecrets = companySecrets[source];
  if (!sourceSecrets) {
    throw new SecretsNotConfigured(`No ${source} credentials configured for company ${companyId}`);
  }

  const schema = sourceSecretSchemas[source];
  const secretsParsed = schema.safeParse(normalizeSecrets(sourceSecrets));
  if (!secretsParsed.success) {
    const missing = [...new Set(secretsParsed.error.issues.map((issue) => formatSchemaIssuePath(issue.path)))].join(", ");
    throw new SecretsNotConfigured(`${source} credentials must include: ${missing}`);
  }

  return secretsParsed.data;
}
