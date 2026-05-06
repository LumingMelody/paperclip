# Paperclip Tool Registry

`@paperclipai/tool-registry` is the read-only data and admin tool layer for
Paperclip agents. It exposes 13 subcommands across 8 sources via two
transports — `pcl-tools` CLI and `pcl-tools-mcp` MCP stdio server — both
backed by a single `ToolDescriptor` registry so descriptions, schemas, and
telemetry stay in lockstep.

Today it covers four data sources (Lingxing MySQL warehouse, Shopify Admin,
Meta Marketing API, Amazon SP-API) and four admin utilities (telemetry
search, decisions log, registry introspection, brief parser, costs roll-up).
All tools are read-only. Write tools and approval gating are Phase 4.

## Install

Within the Paperclip monorepo:

```sh
pnpm install
pnpm --filter @paperclipai/tool-registry build
```

This produces two executables:

| Binary | Path | Use |
|---|---|---|
| `pcl-tools` | `dist/cli.js` | Cross-language CLI; agents/scripts shell into it |
| `pcl-tools-mcp` | `dist/mcp/stdio.js` | MCP stdio server; Claude Code/Cursor/OpenClaw etc. mount this |

The Lingxing helper requires `pymysql`:

```sh
uv pip install pymysql
```

Standalone install (npm publish, external use) is not supported in Phase 3.

## CLI

Every call requires the execution-context flags so telemetry can attribute
the action to a company, project, issue, actor, tool name, and arg hash.
Missing any required context flag exits non-zero with a structured JSON
error to stderr.

```sh
pcl-tools <source> <subcommand> \
  --company <UUID> --project <UUID> --issue <id> --actor <agent|user|system> \
  [--run <runId>] \
  [tool-specific flags…]
```

`pcl-tools --help` lists every registered subcommand.

### All subcommands (13)

| Source | Subcommand | Tool id | What it does |
|---|---|---|---|
| `lingxing` | `fact-sku` | `lingxing.factSku` | Master SKU row by ASIN |
| `lingxing` | `fact-orders` | `lingxing.factOrders` | Aggregated order rows by SKU + since |
| `shopify` | `get-product` | `shopify.getProduct` | Shopify product by handle |
| `shopify` | `list-products-by-collection` | `shopify.listProductsByCollection` | Collection product list |
| `meta` | `ad-account-summary` | `meta.adAccountSummary` | Meta ad account: name/currency/status/balance |
| `meta` | `adset-performance` | `meta.adsetPerformance` | Adset insights for a date range |
| `spapi` | `get-order` | `spapi.getOrder` | Single Amazon order by orderId |
| `spapi` | `list-orders-updated-since` | `spapi.listOrdersUpdatedSince` | Amazon orders updated after timestamp |
| `tool-calls` | `search` | `toolCalls.search` | Search per-project telemetry |
| `decisions` | `search` | `decisions.search` | Search platform `decisions.log` |
| `registry` | `list` | `registry.list` | List all registered tools (introspection) |
| `briefs` | `parse` | `briefs.parse` | Parse Anna action brief markdown into structured JSON |
| `costs` | `rollup` | `costs.rollup` | Aggregate `tool_calls.jsonl` by tool / issue / day / status |

### Examples

```sh
# Master SKU lookup
pcl-tools lingxing fact-sku \
  --company $CO --project $PROJ --issue CRO-37 --actor agent \
  --asin B01N9G3JK7

# Orders since a date
pcl-tools lingxing fact-orders \
  --company $CO --project $PROJ --issue CRO-37 --actor agent \
  --sku-id EE02083DR-US-08 --since 2026-04-01

# Shopify product by handle
pcl-tools shopify get-product \
  --company $CO --project $PROJ --issue CRO-30 --actor agent \
  --handle mermaid-mg02468

# Meta adset performance
pcl-tools meta adset-performance \
  --company $CO --project $PROJ --issue CRO-37 --actor agent \
  --account-id 138486201 --since 2026-04-22 --until 2026-04-28

# Amazon orders updated since
pcl-tools spapi list-orders-updated-since \
  --company $CO --project $PROJ --issue CRO-29 --actor agent \
  --since 2026-04-29T00:00:00Z --max-results 50

# Telemetry: where did the time go?
pcl-tools costs rollup \
  --company $CO --project $PROJ --issue CRO-99 --actor user \
  --since 2026-04-01 --by tool

# Discover what tools exist
pcl-tools registry list \
  --company $CO --project $PROJ --issue CRO-99 --actor agent

# Parse Anna's V3 brief into sections
pcl-tools briefs parse \
  --company $CO --project $PROJ --issue CRO-99 --actor user \
  --path docs/anna-brief/2026-04-30-action-brief-v3.md
```

Successful commands print JSON to stdout. Errors print
`{"error":"<ClassName>","message":"…"}` to stderr and exit non-zero.

## MCP

Build the package, then mount the stdio server in any MCP-aware agent
runtime. Claude Desktop config:

```json
{
  "mcpServers": {
    "paperclip-data": {
      "command": "node",
      "args": ["/abs/path/to/packages/tool-registry/dist/mcp/stdio.js"]
    }
  }
}
```

The MCP server registers every tool from the same `ToolDescriptor[]` the
CLI dispatches from — there is no drift between the two transports. Tools
appear under their dotted `id` (e.g. `lingxing.factSku`).

The MCP handler reads the execution context from the request's `_meta`
field. Missing required keys (`companyId`, `projectId`, `issueId`, `actor`)
return a `ValidationError` response (`isError: true`) instead of throwing.

## Execution context

| Flag | Type | Required | Description |
|---|---|---:|---|
| `--company` | UUID | yes | Paperclip company id; resolves secrets and the per-project telemetry workspace |
| `--project` | UUID | yes | Project id within the company |
| `--issue` | string | yes | Issue identifier (e.g. `CRO-37`) — recorded on every telemetry row |
| `--actor` | enum | yes | `agent` / `user` / `system` |
| `--run` | string | no | Optional agent-run id forwarded to telemetry |

## Secrets

Each call's secrets are loaded from `~/.paperclip/tool-secrets.json` (NOT
the repo). Per-source schemas are validated at load time; missing fields
produce `SecretsNotConfigured: <source> credentials must include: <fields>`.
Secret values never appear in telemetry, `argsHash`, or any error message.

```json
{
  "companies": {
    "<companyId>": {
      "lingxing": {
        "host": "your-mysql-host.tencentcdb.com",
        "port": "3306",
        "user": "readonly_user",
        "password": "***",
        "database": "everypretty"
      },
      "shopify": {
        "shop": "ever-pretty",
        "token": "shpat_***",
        "apiVersion": "2024-10"
      },
      "meta": {
        "accessToken": "EAAB***",
        "apiVersion": "v20.0"
      },
      "spapi": {
        "refreshToken": "Atzr|***",
        "clientId": "amzn1.application-oa2-client.***",
        "clientSecret": "***",
        "region": "na",
        "marketplaceId": "ATVPDKIKX0DER"
      }
    }
  }
}
```

`docs/tool-secrets.example.json` ships a copy-pasteable starter. Admin
tools (`tool-calls`, `decisions`, `registry`, `briefs`, `costs`) require
no secrets.

## Telemetry

Every successful or failing tool call appends a JSON line to:

```
~/.paperclip/instances/<instanceId>/projects/<companyId>/<projectId>/tool_calls.jsonl
```

| Field | Type | When | Notes |
|---|---|---|---|
| `ts` | ISO string | always | UTC timestamp at call start |
| `company` | string | always | from execution context |
| `project` | string | always | from execution context |
| `issue` | string | always | from execution context |
| `runId` | string | optional | from `--run` |
| `tool` | string | always | canonical tool id |
| `argsHash` | string | always | sha256 of canonicalised args, secret-keyed fields redacted |
| `status` | `success`/`error` | always | outcome |
| `durationMs` | number | always | wall-clock |
| `costUnits` | number | optional | reserved for future metered tools |
| `errorClass` | string | only on error | one of the classes below |

Append-only with O_APPEND so concurrent agents can write safely. Aggregate
queries via `costs.rollup`; raw search via `tool-calls search`.

## Error classes

| Name | Exit code | When thrown |
|---|---:|---|
| `ValidationError` | 1 | CLI flags, execution context, or tool input fail validation |
| `SecretsNotConfigured` | 1 | `~/.paperclip/tool-secrets.json` is missing or incomplete for the company/source |
| `InstanceLookupFailed` | 1 | No unique Paperclip instance for the company (zero or multiple) |
| `NotFound` | 1 | Tool ran but the requested entity is absent |
| `UpstreamError` | 2 (CLI normalises to 1) | Subprocess failure, DB/network error, HTTP 5xx |
| `InternalError` | 2 (CLI normalises to 1) | Programmer-error path |

## Architecture

```
        +----------------------+
        |  ToolDescriptor[]    |  <- single source of truth
        |  (src/registry.ts)   |
        +-----+----------+-----+
              |          |
              v          v
        +-----------+ +-----------+
        | CLI       | | MCP stdio |
        | cli.ts    | | mcp/      |
        +-----+-----+ +-----+-----+
              |             |
              v             v
        +------------------------+
        | runTool(ctx, fn)       |  <- executor wraps every call
        | (src/executor.ts)      |     with telemetry, error class
        +-----+--------+---------+
              |        |
              v        v
        +-------------+   +------------+
        | tool source |   | telemetry  |
        | clients     |   | jsonl      |
        +-------------+   +------------+
```

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Lingxing CLI + executor + telemetry | Shipped (`888aa208`) |
| 2 | Registry refactor + MCP transport + Shopify | Shipped (`8d8324b0`) |
| 3 | Meta + Amazon SP-API + admin tools (decisions/registry/briefs/costs) | Shipped (`3f0145cb` → `1ab156a5`) |
| 4 | Write tools (e.g. `shopify.updateProduct`) + approval gating | Deferred |
| 5 | Paperclip routine wiring (cron-trigger close-loop scripts) | Deferred |

## See also

- `decisions.log` (repo root) — architectural decisions including the
  `[2026-04-30]` Phase 1, `[mid-loop]` pymssql→pymysql fix, and Phase 2
  Codex pushback log.
- `docs/superpowers/plans/2026-04-30-tool-registry-phase{1,2}.md` — the
  autoloop plan files used during Phase 1+2 implementation.
- `server/src/services/agent-state-reconciler.ts` — heartbeat reconciler
  shipped in this same wave; see `[2026-04-29]` decisions for its design.
