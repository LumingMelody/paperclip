# Paperclip Server Hardening Plan — autoloop-able

> Codex implements (Task A + B), board implements (Task C). Independent files, no shared state.

**Author**: Claude Opus 4.7 (board), 2026-04-29
**Codex evaluation**: design pre-approved by board, implementation only — no design discussion.
**Repo root**: `/Users/melodylu/PycharmProjects/paperclip`
**Branch**: master
**TypeScript strict**: keep. Don't add new deps.

---

## Task A — Verifier 强制 hook on issue close

**Codex worker**: 1 session, exclusive on this task.

### Why

Currently when an agent (or a user) PATCHes an issue to `status=done` or `status=in_review`, paperclip server simply records the status change. There is **no automatic check** that the agent's last comment claims files exist on disk, that line counts match, that referenced golden metrics are within tolerance, or that confidence/citation annotations are present. The workspace already has a verifier that performs these checks (`workspace/_default/scripts/eval/verifier.ts`, 700+ lines, 21 unit tests passing). The board (Claude) currently runs it manually after each issue close. We want the server to run it automatically and **block the close on FAIL**.

### Spec

Modify the existing PATCH route handler in `server/src/routes/issues.ts` (currently around line 1305, `router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {`).

Behavior:

1. Detect when `req.body.status === "done"` OR `req.body.status === "in_review"` AND the existing record has `status !== "done"` AND `status !== "in_review"` (i.e., this PATCH is the close transition, not an idempotent re-write).
2. Resolve the issue's project workspace path: lookup `companyId + projectId`, then locate `<paperclip-data-root>/instances/<instanceId>/projects/<companyId>/<projectId>/_default/scripts/eval/verifier.ts`. If the file doesn't exist (workspace doesn't have a verifier), skip the check (log "verifier not available" via existing logger) and allow the status change normally.
3. If the verifier file exists, invoke it as a child process: `tsx <verifier-path> --issue-id <issue.identifier>`. Pass `PAPERCLIP_API_URL=http://127.0.0.1:<port>` in the environment so the verifier can call back if it needs to. Use a 30-second timeout. Capture stdout + stderr.
4. Parse the verifier output for the overall status (the verifier prints `✅ Overall: PASS`, `⚠️ Overall: WARN`, or `❌ Overall: FAIL` near the top of stdout). If parsing fails, treat as WARN (don't block, but log).
5. If verifier overall = `FAIL`:
   - Respond `422 Unprocessable Entity`.
   - Body shape: `{ "error": "verifier_failed", "verifyOutput": "<stdout last ~3KB>", "checks": <parsed checks if available, otherwise null> }`.
   - **Do not** persist the status change.
   - Log activity action `issue.close_blocked_by_verifier`.
6. If verifier overall = `WARN` or `PASS`:
   - Persist the status change normally (existing code path).
   - Log activity action `issue.verified` with detail field `{ verifierStatus: "PASS"|"WARN", outputBytes: <length> }`.
   - In the response, **also include** `verifyReport: { status: "PASS"|"WARN", excerpt: "<first 1KB of stdout>" }` so the board can see it without an extra fetch.

### Escape hatch

Honor `executionPolicy.skipVerify === true` on the issue (if the field exists on the issue record's `executionPolicy` object) — when set, skip the entire verifier hook. This lets the board mark unusual issues exempt without bypassing the check globally.

### Implementation hints

- The existing `child_process.spawn` (or `execFile`) is fine. Don't add `execa` or other deps.
- `tsx` is already a workspace dep; `pnpm --filter @paperclipai/server exec which tsx` finds it. Use `node_modules/.bin/tsx` resolved relative to the workspace dir.
- `logActivity` is already used elsewhere in the same file (e.g., line 1276). Match that pattern for the new actions.
- The existing route already has `assertCompanyAccess` + `assertAgentRunCheckoutOwnership` checks before the body — keep those, only add the verifier hook between them and the actual `svc.update(...)` call.
- Follow the existing TypeScript strict types. The verifier output type can be a small local interface; no need to export.

### Tests

Add **one** integration-style test if there's an existing test file `server/src/__tests__/issue-routes.test.ts` (or similar). Mock the verifier subprocess to return PASS / WARN / FAIL and assert:
- PASS / WARN → 200, status persists, response includes `verifyReport`
- FAIL → 422, status NOT persisted, response includes `verifyOutput`
- skipVerify → 200, no subprocess invocation

If no obvious test infra exists for routes that spawn subprocesses, skip the test — don't introduce a new test framework. Document the manual test procedure in a comment near the new code.

### Acceptance

```bash
pnpm typecheck
pnpm test:run                # don't break existing tests
# Manual: PATCH a real issue with status=done while its workspace verifier would FAIL
#         → expect 422 with verifyOutput
#         → reset and try again with executionPolicy.skipVerify=true
#         → expect 200 + status persisted
```

### Out of scope

- Changing the verifier itself (it's in workspace, not server)
- Changing what statuses trigger the hook (only `done` / `in_review`)
- Long-lived verifier worker pool (subprocess per close is fine for v1)
- Caching verifier results
- Running verifier on PATCH that doesn't change status

---

## Task B — Stale-heartbeat auto-recovery cron tick

**Codex worker**: 1 session, exclusive on this task. Independent of Task A.

### Why

Today's session encountered **twice** the pattern where a paperclip dev agent shows `status=running` in the database but `lastHeartbeatAt` is 1+ day stale and `currentRunId=null`. This happens when the dev server crashes or restarts mid-run: the row never gets the "ended" write. The supervisor then short-circuits future wake events with "agent already running" and silently swallows them, so newly assigned issues sit in `todo` forever.

Manual recovery is documented in the skill `paperclip-agent-wake-stuck-stale-heartbeat` (2-step PATCH: agent→idle, then re-PATCH issue). We want the server to do this automatically.

### Spec

Add a periodic state reconciler that runs every 5 minutes inside the paperclip server process. Pseudocode:

```ts
async function reconcileStaleAgents(now: Date): Promise<void> {
  const agents = await db.agents.findMany({
    where: { status: "running", currentRunId: null },
  });
  const STALE_MS = 30 * 60 * 1000; // 30 minutes
  for (const agent of agents) {
    if (!agent.lastHeartbeatAt) continue;
    const staleMs = now.getTime() - agent.lastHeartbeatAt.getTime();
    if (staleMs < STALE_MS) continue;
    await db.agents.update({
      where: { id: agent.id },
      data: { status: "idle" },
    });
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: null,
      agentId: agent.id,
      action: "agent.auto_recovered_stale_heartbeat",
      entityType: "agent",
      entityId: agent.id,
      details: {
        previousStatus: "running",
        newStatus: "idle",
        lastHeartbeatAt: agent.lastHeartbeatAt.toISOString(),
        staleMinutes: Math.floor(staleMs / 60_000),
      },
    });
    // (Optional but nice) emit a telemetry event so this isn't silent.
  }
}
```

### File placement

Create new file `server/src/services/agent-state-reconciler.ts` exporting:
- `reconcileStaleAgents(now: Date): Promise<{ reconciled: number }>` — pure function, no timer
- `startAgentStateReconciler(opts: { intervalMs?: number }): { stop: () => void }` — wraps it in `setInterval`, returns a stop handle

### Bootstrap registration

Find where the paperclip server starts other periodic tasks (look for `setInterval` / `setTimeout` / "supervisor" / "tick" near `server/src/index.ts` or `server/src/bootstrap.ts`). Register `startAgentStateReconciler({ intervalMs: 5 * 60_000 })` there. Make sure the returned `stop()` is called on graceful shutdown (alongside other shutdown handlers).

If the server has no obvious bootstrap point and just runs forever from `index.ts`, register near where the HTTP listener starts and add a `SIGTERM` / `SIGINT` handler that calls `.stop()`. Don't break existing shutdown paths.

### Tests

If a test infra already exists at the service level (e.g., `server/src/__tests__/local-service-supervisor.test.ts`), add a focused test for `reconcileStaleAgents`:
- Inject a fake `now`. Stub the DB layer (drizzle/orm) with two agents: one stale, one fresh.
- Assert only the stale one gets updated and one activity row gets logged.

If there is no easy DB mock pattern, skip the test and add a 5-line explanation comment in the new file.

### Acceptance

```bash
pnpm typecheck
pnpm test:run
# Manual: set an agent's lastHeartbeatAt to 2 hours ago via PATCH (with status=running, currentRunId=null)
#         wait 5 minutes → agent.status should auto-flip to idle
#         /api/activities (or equivalent) should show the agent.auto_recovered_stale_heartbeat entry
```

### Out of scope

- Fixing the root cause (graceful shutdown not writing "ended" status)
- Per-agent custom timeouts
- Running this in the dev runner subprocess vs main server (just put it in main)
- Recovering subprocess-level corruption (we only flip the DB field)
- UI for showing recovered agents (just log activity)

---

## Task C — Issue templates (board does this in parallel)

Not a Codex task — board (Claude) implements directly.

Create 5 markdown templates in `_default/docs/issue-templates/` (workspace, not server repo):

1. `diagnosis.md` — for SKU/market analysis tasks (CRO-16/17/18 pattern)
2. `pilot.md` — for new-channel/new-product tests (CRO-30/37 pattern)
3. `brief-update.md` — for Anna brief patches (CRO-32/38 pattern)
4. `verifier-add.md` — for adding verifier checks (CRO-33/34 pattern)
5. `data-pull.md` — for one-off data extraction (CRO-29 pattern)

Each template:
- Title placeholder
- Why section
- Task section with steps
- Constraints
- Verify(自验)section
- Out of scope
- Background

Mirror the structure I (board) used for CRO-32 through CRO-38. Don't re-derive — copy the best-of pattern.

---

## Coordination

- Tasks A and B touch **different files** in `server/src/`. No merge conflict risk.
- Task C is in workspace `_default/`, completely separate from server code.
- All three can run truly in parallel.
- After all three finish: board reviews diffs, runs `pnpm typecheck` and `pnpm test:run`, commits.

## Rollback

Each task gets its own commit. If A's verifier hook turns out to break a corner case, revert just that commit; B and C unaffected.
