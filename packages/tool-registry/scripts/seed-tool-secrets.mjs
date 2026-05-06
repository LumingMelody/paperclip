#!/usr/bin/env node
/**
 * Pull whatever credentials we can auto-discover from existing local
 * projects and write a draft `~/.paperclip/tool-secrets.json.draft` for
 * Ever-Pretty. Fields we can't auto-discover are left as `***` with a
 * `__hint` neighbour explaining where to find them.
 *
 * Sources scanned:
 *   - ~/PycharmProjects/shopify_spider/.env  →  shopify
 *   - ~/.claude/skills/meta-ads-reporting/scripts/meta_spider.py  →  meta
 * Manual:
 *   - lingxing  (DB_HOST / DB_USER / DB_PASSWORD shell env vars; not in any .env)
 *   - spapi     (lives in SQL Server at 192.168.0.132/everpretty, fetched by
 *                Aws_spider/credential_manager.py)
 *
 * Usage:
 *   node packages/tool-registry/scripts/seed-tool-secrets.mjs
 *   # → writes ~/.paperclip/tool-secrets.json.draft
 *   # → prints summary of what was auto-filled vs needs manual fill
 *
 * Then review and:
 *   mv ~/.paperclip/tool-secrets.json.draft ~/.paperclip/tool-secrets.json
 *   chmod 600 ~/.paperclip/tool-secrets.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COMPANY_ID = "a0f62167-5f88-475b-bdc0-3d4cb80184dc"; // Ever-Pretty
const HOME = homedir();

const SHOPIFY_ENV = join(HOME, "PycharmProjects/shopify_spider/.env");
const META_SCRIPT_CANDIDATES = [
  // Most likely: hardcoded in export_everpretty.py
  join(HOME, ".claude/skills/meta-ads-reporting/scripts/export_everpretty.py"),
  // Fallback: meta_spider.py (reads from env, not literal)
  join(HOME, ".claude/skills/meta-ads-reporting/scripts/meta_spider.py"),
];

const status = {
  shopify: "missing",
  meta: "missing",
  lingxing: "manual",
  spapi: "manual",
};

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// --- Shopify ----------------------------------------------------------------
const shopify = {
  shop: "***",
  token: "***",
  apiVersion: "2024-10",
  __hint: `Pulled from ${SHOPIFY_ENV} (SHOPIFY_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN).`,
};
if (existsSync(SHOPIFY_ENV)) {
  const env = parseEnv(readFileSync(SHOPIFY_ENV, "utf-8"));
  if (env.SHOPIFY_SHOP_DOMAIN) {
    // schema expects subdomain, not full FQDN
    shopify.shop = env.SHOPIFY_SHOP_DOMAIN.replace(/\.myshopify\.com$/i, "");
  }
  if (env.SHOPIFY_ACCESS_TOKEN) shopify.token = env.SHOPIFY_ACCESS_TOKEN;
  if (env.SHOPIFY_API_VERSION) shopify.apiVersion = env.SHOPIFY_API_VERSION;
  if (shopify.shop !== "***" && shopify.token !== "***") status.shopify = "auto";
}

// --- Meta -------------------------------------------------------------------
const meta = {
  accessToken: "***",
  apiVersion: "v20.0",
  __hint:
    `Token typically hardcoded as ACCESS_TOKEN in export_everpretty.py at module scope.`,
};
for (const candidate of META_SCRIPT_CANDIDATES) {
  if (!existsSync(candidate)) continue;
  const text = readFileSync(candidate, "utf-8");
  const literalMatch =
    /ACCESS_TOKEN\s*=\s*["']([A-Za-z0-9_\-]{30,})["']/.exec(text) ??
    /access_token\s*=\s*["']([A-Za-z0-9_\-]{30,})["']/.exec(text);
  if (literalMatch) {
    meta.accessToken = literalMatch[1];
    meta.__hint = `Pulled from ${candidate} (ACCESS_TOKEN literal at module scope).`;
    status.meta = "auto";
    break;
  }
}

// --- Lingxing (manual) ------------------------------------------------------
const lingxing = {
  host: "***",
  port: "3306",
  user: "***",
  password: "***",
  database: "everypretty",
  __hint:
    "Fill from your DB_HOST / DB_USER / DB_PASSWORD shell env vars. " +
    "Reference: close-loop-ads.ts:89-93 reads these. If you don't have the values, " +
    "ask whoever set up the cross-channel pipeline; the warehouse is on Tencent Cloud.",
};

// --- SP-API (manual) --------------------------------------------------------
const spapi = {
  refreshToken: "***",
  clientId: "amzn1.application-oa2-client.***",
  clientSecret: "***",
  region: "na",
  marketplaceId: "ATVPDKIKX0DER",
  __hint:
    "Stored in SQL Server (192.168.0.132/everpretty) — Aws_spider/credential_manager.py loads them per account_id. " +
    "Quickest extraction: connect to that DB and SELECT refresh_token, client_id, client_secret " +
    "FROM <amazon_account_table> WHERE account_id = <EP US account>. " +
    "Or just paste from Aws_spider/data/credentials_cache.json if it has them cached.",
};

// --- Compose ----------------------------------------------------------------
const out = {
  $comment:
    "Auto-generated draft by seed-tool-secrets.mjs. Fill `***` placeholders, remove `__hint` keys, " +
    "then move to ~/.paperclip/tool-secrets.json and chmod 600.",
  companies: {
    [COMPANY_ID]: {
      lingxing,
      shopify,
      meta,
      spapi,
    },
  },
};

const targetDir = join(HOME, ".paperclip");
const draftPath = join(targetDir, "tool-secrets.json.draft");
mkdirSync(targetDir, { recursive: true });
writeFileSync(draftPath, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });

console.log(`Wrote draft to ${draftPath}\n`);
console.log("Auto-fill status by source:");
for (const [source, st] of Object.entries(status)) {
  const icon = st === "auto" ? "✓ auto" : st === "manual" ? "✎ manual" : "? missing";
  console.log(`  ${icon}  ${source}`);
}
console.log("\nNext steps:");
console.log(`  1. Review/edit ${draftPath} — fill any *** values, remove __hint lines`);
console.log("  2. mv ~/.paperclip/tool-secrets.json.draft ~/.paperclip/tool-secrets.json");
console.log("  3. chmod 600 ~/.paperclip/tool-secrets.json");
console.log("  4. Smoke: node packages/tool-registry/dist/cli.js shopify get-product \\");
console.log("       --company a0f62167-5f88-475b-bdc0-3d4cb80184dc \\");
console.log("       --project bed68dec-ddf6-4aa1-b921-48c4630e92c6 \\");
console.log("       --issue CRO-99 --actor user --handle some-product-handle");
