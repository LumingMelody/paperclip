# Changelog

All notable changes to `@paperclipai/tool-registry`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this package follows the parent monorepo's `0.3.x` line.

## [Unreleased] — 2026-04-30

### Cleanup pass

- **CLI numeric flags now coerce strings**: `spapi.listOrdersUpdatedSince`'s
  `maxResults` switched from `z.number()` to `z.coerce.number()`. The CLI's
  flag layer always hands strings to the schema; without coercion the
  documented `--max-results 50` would fail validation. Drive-by check
  confirmed `shopify.listProductsByCollection.limit` and
  `decisions.search.limit` were already on `z.coerce.number()`.
- **Build script extracted**: replaced the multi-line `mkdir && cp ... && cp ... && chmod`
  in `package.json` with `scripts/copy-tool-helpers.mjs`. The script walks
  `src/tools/*/` for any `_query.py` (extensible to future helper file types)
  and copies into the matching `dist/tools/*/` path, then re-`chmod +x` the
  CLI and MCP stdio bins. Adding a new source no longer requires editing
  the build script.

## [0.3.1] — 2026-04-30

### Phase 3 — admin tools + heartbeat root-cause

- `decisions.search` reads platform `decisions.log` (multi-format header parser)
- `registry.list` agent-side tool discovery (works around circular import via
  lazy registry resolve)
- `briefs.parse` Anna action-brief markdown → structured JSON (sections,
  claims tagged VERIFIED/INFERRED/ASSUMPTION)
- `costs.rollup` aggregate `tool_calls.jsonl` by tool / issue / day / status
  (count, errorCount, totalDurationMs, p50, p95, totalCostUnits)
- Server (sibling commit): `reconcileAgentsOnShutdown` complements the
  periodic reconciler tick — graceful SIGTERM/SIGINT now flushes ghost
  running agents immediately so the next boot is clean.

### Phase 3 — Amazon SP-API source (read-only)

- `spapi.getOrder(orderId)` and `spapi.listOrdersUpdatedSince({ since,
  marketplaceId?, maxResults? })`. LWA refresh-token flow + region routing
  (na/eu/fe) per call. Stdlib-only Python helper, no `requests` dep.

### Phase 3 — Meta Marketing API source (read-only)

- `meta.adAccountSummary(accountId)` and `meta.adsetPerformance({ accountId,
  since, until })`. Stdlib `urllib.request`, Graph API v20.0 default.
- Drive-by: CLI `--help` schemaKeys() now walks `ZodEffects` (`.refine`)
  wrappers so refine-augmented schemas (e.g. since<=until) surface their
  fields in usage strings.

## [0.3.0] — 2026-04-30 (Phase 2)

### Added

- **Tool descriptor as canonical model**: every tool exports a
  `ToolDescriptor<I, O>` with `id`, `cliSubcommand`, `source`, `description`,
  `readOnly`, `inputSchema`, `outputSchema?`, `requiredSecrets?`, `handler`.
  Both CLI and MCP layers derive their tool list from a single registry —
  no duplication.
- **`pcl-tools-mcp` MCP stdio server**: agents in any MCP-aware runtime
  (Claude Code/Cursor/OpenClaw) can mount the same tools the CLI exposes.
  Telemetry parity guaranteed by funneling through `runTool(ctx, ...)`.
- **Per-source secret Zod schemas**: `lingxingSecretSchema`,
  `shopifySecretSchema`, `metaSecretSchema`, `spapiSecretSchema` validated
  at context-construction or first-call time. `SecretsNotConfigured` carries
  the missing field list. No env-var fallbacks; secret values never appear
  in telemetry or `argsHash`.
- **Subprocess contract v1**: `runPythonHelper({ helperPath, request,
  responseSchema, envFromSecrets, timeoutMs })` is the only place that
  spawns Python. JSON stdin/stdout, `version` field, AbortController-based
  timeout, no `shell:true`, structured `{error,message}` envelope mapped to
  TS error classes.
- **Shopify Admin source**: `shopify.getProduct(handle)`,
  `shopify.listProductsByCollection({ collectionId, limit? })`. Stdlib
  helper (no `requests` dep).

## [0.2.0] — 2026-04-30 (Phase 1)

### Added

- Initial release: `pcl-tools` CLI with `lingxing.factSku`,
  `lingxing.factOrders`, and `toolCalls.search`.
- Execution context required on every call (`companyId`, `projectId`,
  `issueId`, `actor`, optional `runId`).
- File-based telemetry: `~/.paperclip/instances/<id>/projects/<co>/<proj>/tool_calls.jsonl`,
  append-only with O_APPEND for safe concurrent writes.
- `argsHash`: stable SHA-256 of canonicalised JSON args, secret-keyed
  fields redacted to `[REDACTED]` before hashing.
- Error class hierarchy: `ValidationError`, `SecretsNotConfigured`,
  `InstanceLookupFailed`, `NotFound`, `UpstreamError`, `InternalError`.
- Lingxing helper engine pivot: pre-launch dispatch incorrectly assumed
  SQL Server; verified the EP warehouse is MySQL on Tencent Cloud and
  switched to `pymysql` mid-loop. See `decisions.log`
  `[2026-04-30 mid-loop]`.

## See also

- `decisions.log` (repo root) — architectural decisions including the
  Phase 1+2 Codex pre-implementation pushback transcripts.
- `docs/superpowers/plans/2026-04-30-tool-registry-phase{1,2}.md` — autoloop
  plan files used during Phase 1+2 implementation.
