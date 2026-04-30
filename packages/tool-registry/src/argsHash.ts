import { createHash } from "node:crypto";

const sensitiveKeyPattern = /secret|token|password|key|auth/i;
const redactedValue = "[REDACTED]";

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalizeForHash(value: unknown, keyName?: string): CanonicalJson {
  if (keyName && sensitiveKeyPattern.test(keyName)) return redactedValue;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalizeForHash(item));
  if (isPlainObject(value)) {
    const out: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) out[key] = canonicalizeForHash(child, key);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value));
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}
