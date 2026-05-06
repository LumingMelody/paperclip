#!/usr/bin/env node
/**
 * Lint gate: assert every tool descriptor under src/tools/ has both a
 * matching test file AND is registered in src/registry.ts's tools array.
 *
 * Run: `node packages/tool-registry/scripts/lint-tool-registry.mjs`
 *
 * Exits 1 with a list of issues; 0 if clean. Intended for CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const toolsRoot = join(pkgRoot, "src", "tools");
const registryFile = join(pkgRoot, "src", "registry.ts");

const issues = [];

const registryText = readFileSync(registryFile, "utf-8");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(fullPath));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

const tsFiles = walk(toolsRoot).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("/client.ts"),
);

for (const file of tsFiles) {
  const text = readFileSync(file, "utf-8");
  const exportMatches = [...text.matchAll(/export const (\w+Descriptor)(?::|\s)/g)];
  if (exportMatches.length === 0) continue;

  for (const match of exportMatches) {
    const name = match[1];

    // Check 1: matching test file exists.
    const testFile = file.replace(/\.ts$/, ".test.ts");
    try {
      statSync(testFile);
    } catch {
      issues.push(`${file}: descriptor "${name}" has no neighbour test file (${testFile})`);
    }

    // Check 2: registry.ts imports + uses the descriptor.
    if (!registryText.includes(name)) {
      issues.push(`${file}: descriptor "${name}" not referenced in registry.ts`);
    }
  }
}

if (issues.length === 0) {
  console.log("[lint-tool-registry] OK");
  process.exit(0);
}

console.error("[lint-tool-registry] issues found:");
for (const msg of issues) console.error(`  - ${msg}`);
process.exit(1);
