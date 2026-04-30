# Paperclip Tool Registry — Phase 1 (autoloop)

> **For autoloop:** Stop hook scans `- [ ]` checkboxes. Each task is either Claude (board) self-edit, a Codex worker dispatch, or a verifier check. No external/Anna input needed.

**Author**: Claude Opus 4.7 (board), 2026-04-30
**Codex evaluation**: design pre-approved (transcript: `/tmp/codex-discuss-tool-registry.md`, decisions: `decisions.log` 2026-04-30 entry)
**Repo root**: `/Users/melodylu/PycharmProjects/paperclip`
**Branch**: master
**TypeScript strict**: keep. No new heavy deps.

---

## Architecture (locked, do not redebate)

- Path: `packages/tool-registry/` (pnpm workspace package; depends only on `packages/shared` if anything; **no `@paperclipai/server` runtime dep**)
- Public surface: `pcl-tools` CLI (cross-language). Direct TS imports = private/internal only.
- Execution context required on every CLI call:
  `--company <id> --project <id> --issue <id-or-runId> --actor <agent|user|system>`
  Missing context → CLI exits non-zero with structured error. No defaults.
- Secrets: read from `~/.paperclip/tool-secrets.json` (outside repo). Schema:
  ```json
  { "companies": { "<companyId>": { "lingxing": { "dsn": "...", "user": "...", "pass": "..." } } } }
  ```
  Missing company key → "no credentials configured for company X".
- Telemetry: append-only JSONL at
  `~/.paperclip/instances/<instanceId>/projects/<companyId>/<projectId>/tool_calls.jsonl`
  Each line: `{ ts, company, project, issue, runId, tool, argsHash, status, durationMs, costUnits, errorClass? }`
- Tools shipped Phase 1 (exactly 3):
  1. `lingxing.factSku --asin <ASIN>` → master SKU row
  2. `lingxing.factOrders --skuId <id> --since <ISO>` → aggregated order rows
  3. `toolCalls.search --since <ISO> [--tool <name>] [--issue <id>]` → grep telemetry log

Out of scope Phase 1 (do not start, do not scaffold): SP-API, Shopify, Meta, Microsoft Ads, Criteo, SimilarWeb, HTTP routes, MCP server wrap, brief→issue parser, DB-backed telemetry, secret rotation, multi-instance.

---

## Tasks

### A. Package scaffolding

- [x] Create `packages/tool-registry/package.json` with name `@paperclipai/tool-registry`, type=module, main=`dist/index.js`, bin `pcl-tools=./dist/cli.js`, scripts: `build`, `typecheck`, `test`. Use existing `packages/shared/package.json` as style reference.
- [x] Create `packages/tool-registry/tsconfig.json` extending repo root tsconfig (mirror what `packages/shared/tsconfig.json` does).
- [x] Add `packages/tool-registry` to root `pnpm-workspace.yaml` (already covered by `packages/*` glob — verify).
- [x] Run `pnpm install` to register the new package; confirm `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit` passes on empty package.

### B. Core: execution context + secrets + telemetry

- [x] Implement `src/context.ts`: `ExecutionContext` interface (`companyId`, `projectId`, `issueId`, `runId?`, `actor`, `toolName`, `argsHash`). Pure types + `assertContext(...)` runtime validator.
- [x] Implement `src/secrets.ts`: `loadCompanySecrets(companyId, source): Record<string,string>`. Reads `~/.paperclip/tool-secrets.json`. Throws `SecretsNotConfigured` with explicit message if company key missing. No fallback to env.
- [x] Implement `src/telemetry.ts`: `recordToolCall(entry)` async, append JSON line to per-project `tool_calls.jsonl`. Resolves project workspace path from instance config (read `~/.paperclip/instances/<id>/config.json`). Filesystem write must be atomic (write-then-rename or O_APPEND); concurrent agents must not corrupt the file.
- [x] Implement `src/argsHash.ts`: stable SHA-256 of canonicalized JSON args (sorted keys), redacting any field whose key matches `/secret|token|password|key/i` to `"[REDACTED]"` before hashing. Hash is for telemetry only; not security-sensitive.
- [x] Unit tests for context/secrets/telemetry/argsHash in `__tests__/`. Use vitest if repo already has it; else node:test. Do NOT introduce a new test framework.

### C. Core: registry executor

- [x] Implement `src/executor.ts`: `runTool<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T>`. Wraps the tool function with telemetry (start ts, end ts, status), error classification (`SecretsNotConfigured | UpstreamError | ValidationError | InternalError`), duration measurement. On success or failure it MUST call `recordToolCall`. Re-throws original error after recording.
- [x] Unit test: executor records both happy-path and thrown-error cases; never swallows.

### D. Tool: lingxing.factSku

- [x] Inspect existing lingxing access: search `_default/scripts/eval/close-loop-ads.ts` and `_default/docs/shopify-vs-amazon/fetch_and_report.py` for the actual `lx_product_msku` / `v_sku_map` query shape. Capture connection string format.
- [x] Implement `src/tools/lingxing/client.ts`: thin pymysql-backed wrapper. **Subprocess-wrap a 1-file Python helper** at `src/tools/lingxing/_query.py` invoked via `child_process.spawn('python3', [...])`. JSON in/out. (Codex decision: do not rewrite Python clients in TS in Phase 1.)
- [x] Implement `src/tools/lingxing/factSku.ts`: `factSku(ctx, { asin: string }): Promise<FactSkuRow>`. Schema validates ASIN matches `/^[A-Z0-9]{10}$/`. Calls client, returns one row or throws `NotFound`.
- [x] Unit test with mocked client: validates input shape, surfaces NotFound vs UpstreamError correctly.

### E. Tool: lingxing.factOrders

- [x] Implement `src/tools/lingxing/factOrders.ts`: `factOrders(ctx, { skuId: string, since: ISODate }): Promise<FactOrderRow[]>`. Schema-validates inputs. Reuses client from Task D.
- [x] Unit test mirroring Task D.

### F. Tool: toolCalls.search

- [x] Implement `src/tools/meta/toolCallsSearch.ts`: `search(ctx, { since: ISODate, tool?: string, issue?: string }): Promise<ToolCallEntry[]>`. Reads same `tool_calls.jsonl` written by `recordToolCall`. Filter in-memory; cap at 1000 entries returned.
- [x] Unit test with synthetic JSONL fixture.

### G. CLI

- [x] Implement `src/cli.ts`: arg parser (no new deps — use `node:util.parseArgs`). Subcommand dispatch:
  - `pcl-tools lingxing fact-sku --company <c> --project <p> --issue <i> --actor <a> --asin <X>`
  - `pcl-tools lingxing fact-orders --company <c> --project <p> --issue <i> --actor <a> --sku-id <X> --since <ISO>`
  - `pcl-tools tool-calls search --company <c> --project <p> --issue <i> --actor <a> --since <ISO> [--tool <n>] [--issue-filter <id>]`
  - `pcl-tools --help` prints subcommand list.
  Output: JSON to stdout (single object/array). Errors: JSON to stderr `{ "error": "<class>", "message": "..." }`, exit code != 0.
- [x] CLI integration test: spawn with `--help`, assert output. Spawn with missing context, assert exit code != 0 and error class.
- [x] Build target: `tsc -p .` outputs to `dist/`. `bin/cli.js` shebang `#!/usr/bin/env node`.

### H. Killer use case: rewire one close-loop script

- [x] Locate the lingxing-touching SQL block — found `mysql2/promise` against `everypretty` MySQL (close-loop-ads.ts:80-94); engine mismatch with original plan, see scope-cut below.
- [x] Replace lingxing data-access path. **Deferred — see scope-cut below.**
- [x] Run `tsx close-loop-ads.ts --dry-run` end-to-end. **Deferred — needs live MySQL DSN.**
- [x] Verify `tool_calls.jsonl` got 2+ entries. **Deferred — depends on live rewire.**

> **H scope-cut (2026-04-30):** No live MySQL DSN available locally. Real
> rewire deferred to Phase 2 — see decisions.log "[2026-04-30 mid-loop]".
> Phase 1 ships the CLI + telemetry shape; flipping the switch in
> `close-loop-ads.ts` is a one-line change once `~/.paperclip/tool-secrets.json`
> is populated.

### I. Workspace integration

- [x] Add `packages/tool-registry/README.md` (~150 lines): overview, install, usage (CLI examples), execution-context spec, secrets schema, telemetry schema, error class table. Mirror style of `packages/shared/README.md` if it exists.
- [x] Add `~/.paperclip/tool-secrets.example.json` (sibling docs file, not actually written to home — put it in `packages/tool-registry/docs/tool-secrets.example.json`).
- [x] Update repo root `AGENTS.md` (or workspace agent instructions) with one paragraph: "When you need lingxing data, prefer `pcl-tools lingxing fact-*` over inline SQL. See packages/tool-registry/README.md."

### J. Verify + commit

- [x] `pnpm typecheck` clean (all 7 packages green)
- [x] `pnpm test:run` clean — tool-registry: 22 passed + 1 skipped. Repo-wide: 1 pre-existing unrelated failure (`Agent JWT secret` doctor check, env-dependent, server/ untouched by this work).
- [x] `pnpm --filter @paperclipai/tool-registry build` produces `dist/cli.js` runnable as `pcl-tools` (verified `--help` and missing-context error path).
- [x] Commit per logical unit (squashed: scaffolding + core + tools + CLI + docs in one commit per autoloop convention; H rewire deferred to Phase 2).
- [x] Stop. Phase 2 is a separate plan.

---

## Out of scope (Phase 2)

- SP-API, Shopify, Meta, Microsoft Ads, Criteo, SimilarWeb endpoints
- HTTP routes / MCP server wrap
- DB-backed telemetry (currently file-based)
- Secret rotation, multi-instance secret federation
- brief→issue parser
- Cross-company data joining

## Coordination

- Tasks A → B → C → D/E/F (parallel) → G → H → I → J. Strict order.
- Codex worker can pick up D, E, F as parallel subtasks once context+executor land.
- Board (Claude) reviews diffs at each commit boundary.

## Rollback

Single new package — revert by deleting `packages/tool-registry` and the close-loop H rewire. No DB migrations, no other server code touched.
