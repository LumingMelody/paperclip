#!/usr/bin/env node
/**
 * Copy every `_query.py` (or any other helper file we may add) from
 * src/tools/<source>/ into dist/tools/<source>/ after tsc emits.
 *
 * Each new source automatically gets covered — no need to extend the
 * package.json build script when adding lingxing/shopify/meta/spapi/...
 *
 * Usage (from package root): `node scripts/copy-tool-helpers.mjs`
 */
import { readdirSync, mkdirSync, copyFileSync, statSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const srcToolsRoot = join(pkgRoot, "src", "tools");
const distToolsRoot = join(pkgRoot, "dist", "tools");

const HELPER_FILE_NAMES = new Set([
  "_query.py",
]);

function copyHelpersFor(sourceDirName) {
  const srcDir = join(srcToolsRoot, sourceDirName);
  if (!statSync(srcDir).isDirectory()) return 0;
  const distDir = join(distToolsRoot, sourceDirName);
  let copied = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!HELPER_FILE_NAMES.has(entry.name)) continue;
    if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
    const from = join(srcDir, entry.name);
    const to = join(distDir, entry.name);
    copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

let total = 0;
for (const dir of readdirSync(srcToolsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  total += copyHelpersFor(dir.name);
}

// Bins must remain executable after rebuild.
for (const binPath of [join(pkgRoot, "dist", "cli.js"), join(pkgRoot, "dist", "mcp", "stdio.js")]) {
  if (existsSync(binPath)) chmodSync(binPath, 0o755);
}

console.log(`[copy-tool-helpers] copied ${total} helper file(s)`);
