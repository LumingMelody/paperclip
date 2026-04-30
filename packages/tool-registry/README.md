# Paperclip Tool Registry

`@paperclipai/tool-registry` provides the `pcl-tools` CLI for agent-safe access to external operating data. Phase 1 keeps the surface narrow: Lingxing warehouse reads and local telemetry search, with typed arguments, per-company secrets isolation, and `tool_calls.jsonl` records written into each project workspace.

## Install

Within the Paperclip monorepo:

```sh
pnpm install
pnpm --filter @paperclipai/tool-registry build
```

The package exposes `pcl-tools` from `dist/cli.js` after build:

```sh
node packages/tool-registry/dist/cli.js --help
```

Standalone installation is not supported yet. Use this package from the Paperclip workspace until the package is published with a stable external contract.

## CLI Usage

All commands require execution-context flags so telemetry can be attributed to a company, project, issue, actor, tool name, and argument hash.

Fetch a Lingxing SKU fact row by ASIN:

```sh
pcl-tools lingxing fact-sku \
  --company company_123 \
  --project project_456 \
  --issue issue_789 \
  --actor agent \
  --asin B01N9G3JK7
```

Fetch Lingxing order facts by seller SKU and start date:

```sh
pcl-tools lingxing fact-orders \
  --company company_123 \
  --project project_456 \
  --issue issue_789 \
  --actor agent \
  --sku-id EE00001-US12 \
  --since 2026-04-01
```

Search recorded tool telemetry:

```sh
pcl-tools tool-calls search \
  --company company_123 \
  --project project_456 \
  --issue issue_789 \
  --actor agent \
  --since 2026-04-01T00:00:00.000Z \
  --tool lingxing.factOrders \
  --issue-filter issue_789
```

`--run <runId>` is optional for every command. Successful commands print JSON to stdout. Errors print JSON to stderr:

```json
{
  "error": "ValidationError",
  "message": "Invalid execution context: actor: Required"
}
```

## MCP usage

Build the package, then point Claude Desktop at the MCP stdio entrypoint:

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

## Execution Context

| Flag | Type | Required | Description |
|---|---|---:|---|
| `--company` | string | yes | Paperclip company id used for secret lookup and telemetry partitioning. |
| `--project` | string | yes | Project id used to resolve the project workspace. |
| `--issue` | string | yes | Issue id attributed to the tool call. |
| `--actor` | `agent`, `user`, `system` | yes | Caller class recorded in the execution context. |
| `--run` | string | no | Optional run id written to telemetry. |

## Secrets Schema

Lingxing credentials are read from `~/.paperclip/tool-secrets.json` by company id and source name. See [docs/tool-secrets.example.json](docs/tool-secrets.example.json).

Expected shape:

```json
{
  "companies": {
    "company_123": {
      "lingxing": {
        "host": "your-mysql-host.tencentcdb.com",
        "port": "3306",
        "user": "readonly_user",
        "password": "REDACTED",
        "database": "everypretty"
      }
    }
  }
}
```

## Telemetry Schema

Telemetry is appended as JSONL at:

```txt
~/.paperclip/instances/<instance>/projects/<companyId>/<projectId>/tool_calls.jsonl
```

| Field | Type | Required | Description |
|---|---|---:|---|
| `ts` | ISO string | yes | Start timestamp for the tool call. |
| `company` | string | yes | Company id from the execution context. |
| `project` | string | yes | Project id from the execution context. |
| `issue` | string | yes | Issue id from the execution context. |
| `runId` | string | no | Optional run id from `--run`. |
| `tool` | string | yes | Canonical tool name, for example `lingxing.factOrders`. |
| `argsHash` | string | yes | SHA-256 hash of normalized command arguments. |
| `status` | `success`, `error` | yes | Tool outcome. |
| `durationMs` | number | yes | Wall-clock duration. |
| `costUnits` | number | no | Reserved for future metered tools; Phase 1 writes `0`. |
| `errorClass` | string | no | Present when `status` is `error`. |

## Error Classes

`pcl-tools` currently exits with code `1` for all command errors and writes the typed class to stderr. The Python Lingxing helper may use internal exit codes, but the CLI normalizes failures into this contract.

| Name | Exit code | When thrown |
|---|---:|---|
| `SecretsNotConfigured` | 1 | Missing, invalid, or incomplete `~/.paperclip/tool-secrets.json` credentials. |
| `InstanceLookupFailed` | 1 | No unique Paperclip instance can be resolved for the company/project workspace. |
| `ValidationError` | 1 | CLI flags, execution context, or tool input fail validation. |
| `UpstreamError` | 1 | Lingxing helper startup, database access, or upstream query execution fails. |
| `NotFound` | 1 | A read succeeds but the requested fact row is absent. |
| `InternalError` | 1 | An unexpected non-tool-registry error escapes command handling. |

## Phase 2 Deferred

- SP-API tools.
- Shopify tools.
- Brief-to-issue parser.

## Status

Phase 1 — Lingxing read-only, file-based telemetry.
