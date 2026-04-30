# Paperclip Tool Registry — Phase 2 (autoloop)

> **For autoloop:** Stop hook scans `- [ ]` checkboxes. Each task is either Claude (board) self-edit, a Codex worker dispatch, or a verification check. No external/Anna input needed.

**Author**: Claude Opus 4.7 (board), 2026-04-30 evening
**Codex evaluation**: design pre-approved (transcript `/tmp/codex-discuss-mcp-and-sources.md`, decisions: `decisions.log` 2026-04-30 evening entry)
**Repo root**: `/Users/melodylu/PycharmProjects/paperclip`
**Branch**: master
**TypeScript strict**: keep. No new heavy deps beyond `@modelcontextprotocol/sdk`.

---

## Architecture (locked, do not redebate)

- Same package as Phase 1: `packages/tool-registry/`. Add MCP transport + Shopify source only. Do NOT extend `packages/mcp-server/`.
- Canonical model = **tool descriptor**:
  ```ts
  interface ToolDescriptor<I, O> {
    id: string;                    // dotted, e.g. "lingxing.factSku"
    description: string;
    source: string;                // "lingxing" | "shopify" | "meta" (meta source = registry itself)
    readOnly: true;                // Phase 2 read-only; write requires approval (Phase 4)
    inputSchema: z.ZodSchema<I>;
    outputSchema: z.ZodSchema<O>;
    requiredSecrets?: string[];    // names of secret keys this tool needs
    handler: (ctx: ExecutionContext, input: I) => Promise<O>;
  }
  ```
  Both CLI and MCP layers derive their tool list from a single `registry.ts` exporting `ToolDescriptor[]`.
- MCP tool naming: dotted + camelCase (e.g. `lingxing.factSku`). CLI keeps kebab subcommand aliases (`lingxing fact-sku`) for backward compat.
- Subprocess helper contract v1 (every Python helper conforms):
  - stdin: JSON object with at minimum `{ version: "1", op: string, ... }`
  - stdout: JSON `{ row?, rows?, error?, message? }` — never partial writes; emit once and exit
  - exit codes: 0 success, 1 validation error, 2 upstream error
  - timeout: handler-configurable (default 30s); enforced TS-side via `AbortController`
  - stderr: captured + included in `UpstreamError` message on non-zero exit
  - no shell interpolation (no `shell: true`); env vars only
  - test fixture file per helper (mock conn details + recorded responses)
- Secrets remain physically loose in `~/.paperclip/tool-secrets.json` (`Record<string,string>` per source), but each source defines a Zod schema validated at context construction or first tool call. Validation failure → `SecretsNotConfigured` with explicit field-list message. Secret values NEVER appear in telemetry or `argsHash`.

Out of scope Phase 2 (do not start, do not scaffold): Meta Marketing API, Amazon SP-API, write tools, approval gating, multi-tenant secret federation, brief→issue parser, HTTP routes (MCP is the new transport).

---

## Tasks

### A. Registry metadata refactor

- [x] Create `src/registry.ts` exporting `ToolDescriptor<I, O>` interface and `tools: ToolDescriptor[]` array (initially empty — populated by source files via re-export).
- [x] Migrate Phase 1 tools to descriptor form: `lingxing.factSku`, `lingxing.factOrders`, `toolCalls.search`. Each source file exports its descriptor(s); `registry.ts` re-collects them.
- [x] Refactor `src/cli.ts` to dispatch from `registry`: subcommand router maps `<source> <op-kebab>` → descriptor by lookup. Existing CLI behavior unchanged for callers.
- [x] Update `src/cli.test.ts` to assert dispatcher uses registry (not direct imports). Existing tests should still pass.
- [x] `pnpm --filter @paperclipai/tool-registry typecheck && test:run` clean.

### B. Per-source secret Zod schemas

- [x] Add `src/secrets-schemas.ts`: export `lingxingSecretSchema`, `toolCallsSecretSchema` (no secrets needed → empty schema), and a registry mapping `source → schema`.
- [x] Refactor `src/secrets.ts` `loadCompanySecrets(companyId, source)` to fetch the source's schema, parse the loose record, and either return a typed object or throw `SecretsNotConfigured("<source> credentials must include: <missing-fields>")`.
- [x] Update `src/tools/lingxing/client.ts` to use the typed result (drop the local `connectionSecretsSchema`).
- [x] Add unit tests in `src/secrets.test.ts`: missing field → `SecretsNotConfigured` with the exact field name; valid → typed return.
- [x] Verify telemetry / argsHash never contain secret values (grep test).

### C. Subprocess helper contract v1

- [x] Create `src/subprocess.ts`: `runPythonHelper<I, O>({ helperPath, request, timeoutMs, schema }): Promise<O>`. Implementation:
  - Validates `request` against `requestSchema = z.object({ version: z.literal("1"), op: z.string(), ...payload })` (caller provides the merged shape).
  - Spawns `python3 <helperPath>` with `stdio: ["pipe","pipe","pipe"]`, no `shell`.
  - Writes JSON to stdin, ends.
  - Captures stdout / stderr; sets up `AbortController` with `timeoutMs` (default 30_000).
  - Parses stdout as JSON. If `{ error, message }` shape → throws appropriate error class (UpstreamError / ValidationError / NotFound based on `error` field).
  - On non-zero exit without recognizable error JSON → `UpstreamError(stderr || stdout)`.
  - On timeout → `UpstreamError("python helper timed out after Xms")` after killing the process.
- [x] Migrate `src/tools/lingxing/client.ts` to use `runPythonHelper`. Remove the inline spawn code (now lives in `subprocess.ts`).
- [x] Add `src/tools/lingxing/_query.py` `version` field to its emit-on-error and success cases (mirror in `subprocess.ts` validation).
- [x] Unit tests for `subprocess.ts`: success path, error envelope, timeout, no-shell-interp, stderr capture. Use a tiny inline test helper script (`echo`-style python one-liner) or a vitest fs-fixture. Do NOT introduce new deps.

### D. MCP server in tool-registry

- [x] Add dependency `@modelcontextprotocol/sdk` to `packages/tool-registry/package.json` (check what version `packages/mcp-server` uses; align). This is the only allowed new dep.
- [x] Create `src/mcp/server.ts`: function `createMcpServer(registry: ToolDescriptor[]): McpServer`. For each descriptor:
  - Register an MCP tool with `name = descriptor.id` (dotted form), `description = descriptor.description`, `inputSchema` derived from `descriptor.inputSchema` via a shared Zod-to-JSON-schema helper.
  - Handler reads execution-context from MCP request meta (companyId/projectId/issueId/runId/actor) — MCP spec 2025-06-18 supports `_meta` field. If meta missing required keys → return `ValidationError`.
  - Wrap handler call with `runTool(ctx, () => descriptor.handler(ctx, input))` so telemetry/error-classification matches CLI exactly.
- [x] Create `src/mcp/stdio.ts` (executable): boots `createMcpServer(tools)` over `StdioServerTransport`. Add `bin` entry `pcl-tools-mcp` to `package.json` pointing at `./dist/mcp/stdio.js`.
- [x] Mirror the build script: ensure tsc emits `dist/mcp/stdio.js` and the build copy step also chmods it executable.
- [x] Unit tests in `src/mcp/server.test.ts`: synthesize a request → assert correct tool dispatch, telemetry record happens, missing-meta returns ValidationError. Mock executor (don't actually hit DB).
- [x] End-to-end smoke (`it.skip` if requires running server): spawn `pcl-tools-mcp` via stdio, send `tools/list`, assert response contains all 3 Phase 1 tool ids.
- [x] README.md update: new "MCP usage" section with example Claude Desktop config snippet:
  ```json
  {
    "mcpServers": {
      "paperclip-data": {
        "command": "node",
        "args": ["packages/tool-registry/dist/mcp/stdio.js"]
      }
    }
  }
  ```

### E. Shopify source (proves non-lingxing pattern)

- [x] Inspect existing Shopify access: read shopify_spider's `shopify_base_client.py` for auth (`X-Shopify-Access-Token`) + URL pattern + default version 2024-10. Did NOT import shopify_spider — fresh stdlib helper.
- [x] Add `shopifySecretSchema` to `src/secrets-schemas.ts`.
- [x] Create `src/tools/shopify/_query.py`: stdlib `urllib.request`, subprocess contract v1, both ops.
- [x] Create `src/tools/shopify/client.ts` using `runPythonHelper`.
- [x] Create `src/tools/shopify/getProduct.ts` with kebab-case handle validator.
- [x] Create `src/tools/shopify/listProductsByCollection.ts` with limit 1-250 default 50.
- [x] Re-export both descriptors from `src/registry.ts`.
- [x] Unit tests for both Shopify tools (passing in 13-file suite).
- [x] CLI smoke verified: produces structured `SecretsNotConfigured` error on no-secrets dev box, exit ≠0.

### F. Verify + commit

- [x] `pnpm typecheck` clean across all 7+ packages.
- [x] `pnpm --filter @paperclipai/tool-registry test:run` clean: **43 passed + 2 skipped across 13 test files** (was 22+1 in Phase 1).
- [x] `pnpm --filter @paperclipai/tool-registry build` produces both `dist/cli.js` and `dist/mcp/stdio.js` (both chmod +x), plus copied `_query.py` for lingxing and shopify.
- [x] CLI smoke: `--help` lists 5 subcommands (3 lingxing/meta + 2 shopify).
- [x] MCP smoke: requires JSON-RPC handshake per spec; ad-hoc `< /dev/null` not meaningful. Confirmed bin file built, executable, and structurally sound via unit tests in `src/mcp/server.test.ts` (6 passed + 1 skipped e2e).
- [x] Commit (single squashed commit per autoloop convention).
- [x] Stop. Phase 3 (Meta + SP-API) is a separate plan.

---

## Out of scope (Phase 3+)

- Meta Marketing API tools
- Amazon SP-API tools
- Write tools (`shopify.updateProduct`, `lingxing.recordCogs`, etc.) + approval gating
- Multi-tenant secret federation (per-instance vs per-company precedence rules)
- DB-backed telemetry replacement of `tool_calls.jsonl`
- HTTP/REST transport (MCP is the new transport for now)
- Brief→issue parser

## Coordination

- A → B → C → D → E. Strict-ish order; A and B can interleave but B builds on A's `requiredSecrets` field.
- Codex worker can pick up D and E as separate sessions once A/B/C land.
- Board (Claude) reviews diffs at each commit boundary.

## Rollback

Each task is one commit. If MCP turns out broken in some agent runtime, revert just commit 3; CLI stays working. If Shopify tool breaks, revert commit 4; MCP keeps serving lingxing tools.
