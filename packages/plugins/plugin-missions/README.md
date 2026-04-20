# @paperclipai/plugin-missions

First-party Missions plugin package for Paperclip mission orchestration workflows.

This package is the packaging and installation home for the Missions plugin in the
current alpha plugin runtime. Install is instance-wide, but the workflow it owns
is company-scoped once the worker logic is invoked against company issues.

Today this package carries the plugin identity, local install path, verification
commands, and basic health surface. Mission advance/findings/waiver behavior
continues to land in the same package under the sibling implementation issues.

## Operator Workflow

Build the plugin, then install it into the local Paperclip instance by repo path:

```bash
pnpm --filter @paperclipai/plugin-missions typecheck
pnpm --filter @paperclipai/plugin-missions test
pnpm --filter @paperclipai/plugin-missions build
pnpm paperclipai plugin install ./packages/plugins/plugin-missions
```

The current first-party install path is a checked-out local package path. Do not
document npm publishing for this plugin until the release/distribution path is
ready.

API install is equivalent:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip/packages/plugins/plugin-missions","isLocalPath":true}'
```

Build first. The host loads the worker and UI from the manifest entrypoints under
`dist/`, so a fresh install without a build will fail activation.

## Developer Workflow

From the repo root:

```bash
pnpm --filter @paperclipai/plugin-missions typecheck
pnpm --filter @paperclipai/plugin-missions test
pnpm --filter @paperclipai/plugin-missions build
```

For local iteration inside the package directory:

```bash
pnpm install
pnpm dev
pnpm dev:ui
```

## Maintenance Path

The main package files are:

- `src/manifest.ts` for plugin identity, capabilities, and mounted UI slots
- `src/worker.ts` for worker lifecycle, state, events, and orchestration logic
- `src/ui/index.tsx` for the currently mounted UI surface
- `tests/plugin.spec.ts` for package-local verification

When the Missions workflow changes, keep the package README and the targeted
verification commands in sync with the actual install path and runtime surface.

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
