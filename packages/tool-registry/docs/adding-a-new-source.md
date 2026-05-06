# Adding a new data source

This walks through the work to plug in a new source (e.g. `criteo`,
`microsoft_ads`, `similarweb`) using the patterns established in Phase 1-3.
Total clean implementation: about 20-40 minutes per source. The example
references `shopify` (the simplest non-lingxing source).

## 1. Per-source secret schema

Add a Zod schema in `src/secrets-schemas.ts` and register it in
`sourceSecretSchemas`:

```ts
export const criteoSecretSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
}).strict();

export const sourceSecretSchemas = {
  // ...existing,
  criteo: criteoSecretSchema,
} as const;
```

The CLI's `loadCompanySecrets(companyId, "criteo")` now returns a typed
object; missing fields surface as
`SecretsNotConfigured: criteo credentials must include: apiKey, apiSecret`.

## 2. Subprocess helper (only if the source already has a working Python client)

If a Python client exists upstream (`shopify_spider`, `meta-ads-reporting`,
etc.), wrap rather than rewrite. Create `src/tools/<source>/_query.py`:

```python
#!/usr/bin/env python3
PROTOCOL_VERSION = "1"

def emit(payload, code=0):
    print(json.dumps({"version": PROTOCOL_VERSION, **payload}, ensure_ascii=False))
    raise SystemExit(code)

def read_request():
    req = json.loads(sys.stdin.read())
    if req.get("version") != PROTOCOL_VERSION:
        emit({"error": "ValidationError", "message": "..."}, 1)
    return req
```

Use **stdlib only** (`urllib.request`) unless the upstream client requires a
specific HTTP package — keeps the helper deployable without `pip install`.

`scripts/copy-tool-helpers.mjs` automatically picks up any `_query.py`
under `src/tools/*/` — no build-script edit needed.

## 3. TS client.ts

```ts
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCompanySecrets } from "../../secrets.js";
import { runPythonHelper } from "../../subprocess.js";

const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));

export type CriteoRequest = { op: "campaignReport"; advertiserId: string; since: string };

const responseSchema = z.union([
  z.object({ version: z.literal("1"), rows: z.array(z.unknown()) }),
]);

export async function queryCriteo(companyId: string, request: CriteoRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "criteo");
  return runPythonHelper({
    helperPath,
    request: { version: "1", ...request },
    responseSchema,
    envFromSecrets: {
      CRITEO_API_KEY: secrets.apiKey,
      CRITEO_API_SECRET: secrets.apiSecret,
    },
    timeoutMs: 25_000,
  });
}
```

For pure-TS sources (no Python helper), call `fetch` directly instead of
`runPythonHelper` and skip step 2.

## 4. Tool descriptor

One file per (source, op). Each exports a `ToolDescriptor`:

```ts
import { z } from "zod";
import type { ToolDescriptor } from "../../registry.js";
import { queryCriteo } from "./client.js";

const inputSchema = z.object({
  advertiserId: z.string().min(1),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

const outputSchema = z.object({ rows: z.array(z.unknown()) });

export const campaignReportDescriptor: ToolDescriptor<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  id: "criteo.campaignReport",
  cliSubcommand: "campaign-report",
  source: "criteo",
  description: "Fetch Criteo campaign-day rollup (read-only).",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: ["apiKey", "apiSecret"],
  handler: async (ctx, input) => {
    const result = await queryCriteo(ctx.companyId, { op: "campaignReport", ...input });
    return outputSchema.parse(result);
  },
};
```

CLI flags are derived automatically from the input schema's keys (kebab-cased).

## 5. Register

In `src/registry.ts`:

```ts
import { campaignReportDescriptor } from "./tools/criteo/campaignReport.js";

export const tools: ToolDescriptor[] = [
  // ...existing,
  campaignReportDescriptor,
];
```

The CLI `--help`, MCP server tool list, and `registry.list` introspection
will all auto-pick-up the new descriptor.

## 6. Tests

One test file per descriptor. Mock `runPythonHelper` (or `fetch`) so the
test never hits the network:

```ts
const mocks = vi.hoisted(() => ({
  loadCompanySecrets: vi.fn(),
  runPythonHelper: vi.fn(),
}));
vi.mock("../../secrets.js", () => ({ loadCompanySecrets: mocks.loadCompanySecrets }));
vi.mock("../../subprocess.js", () => ({ runPythonHelper: mocks.runPythonHelper }));

const { campaignReportDescriptor } = await import("./campaignReport.js");

// happy path, input validation, error envelope from helper, etc.
```

## 7. Verify

```sh
pnpm --filter @paperclipai/tool-registry exec tsc --noEmit
pnpm --filter @paperclipai/tool-registry test:run
pnpm --filter @paperclipai/tool-registry build
node packages/tool-registry/dist/cli.js --help            # new subcommand listed
node packages/tool-registry/dist/cli.js criteo campaign-report --help   # tool-level help
node packages/tool-registry/dist/cli.js criteo campaign-report --company X --project Y --issue Z --actor agent --advertiser-id A --since 2026-04-01
```

`scripts/lint-tool-registry.mjs` also flags any new descriptor that's
missing a test file or isn't in the registry array.

## 8. Phase 4: write tools

When you eventually need a write tool (e.g. `criteo.updateCampaignBid`),
follow steps 1-7 with these additions:
- Set `readOnly: false` in the descriptor.
- Funnel through `approvalService` (Phase 4 plumbing — TBD) before the
  upstream call.
- Idempotency key in the input schema, recorded in telemetry.

This is deferred to Phase 4 — read-only tools should cover most agent
work for now.
