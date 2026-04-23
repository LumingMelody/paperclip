# Run A — Notes

Review artifact for the Claude Code path (Run A) of the Agent Profile Dashboard redesign. Organized as decisions → deviations → findings → deferred items → rubric link, for readers who weren't present during the work.

---

## 1. Header

**What Run A is.** The Claude Code path of a two-path experiment redesigning the Dashboard tab of the Agent Profile page in Paperclip. Run B (not executed here) is the Paperclip-agent-team path working from the same brief + rubric + reference.

**What was built.** A full redesign of the three in-scope inline components inside `ui/src/pages/AgentDetail.tsx` — `AgentOverview`, `LatestRunCard`, and `CostsSection` (brief lines 1170–1413 of baseline). The redesign ships a hero-band primary-monitoring surface, a single consolidated chart, a priority-affordance on the in-flight tasks list, and a unified costs module.

**Branch.** `run-a-claude-code`, branched from `master` at `0f5895e4` (operating-principles commit). 12 commits across five phases (Phase 0 discovery → Phase 4 polish). Not pushed. Final commits:

```
873f15d9 Phase 4 polish: suppress chart legend when there's nothing to legend
ec37967d Phase 4 polish: normalize module heading hierarchy
859523b5 Phase 3d: unified costs
917b72aa Phase 3c: priority affordance
0710f166 Phase 3b polish: chart legend and rich tooltips
51dd51b9 Phase 3b: chart consolidation
774679bf Phase 3a polish round 3: hero-spanning activity pill
4996295b Phase 3a polish round 2: compact run feed replaces icon strip
568e1c15 Phase 3a polish: 50/25/25 hero layout and shadcn tooltips
6b0f4079 Phase 3a: hero module redesign
389f8105 Phase 2 fix: derive dashboard activity-state from runs, complete budget window
78eed3b1 Phase 2: Agent Profile Dashboard structural frame
```

**Companion document.** Rubric self-scoring is in [`run-a-self-check.md`](./run-a-self-check.md).

---

## 2. Decisions made, with reasoning

### 2.1 Activity-state is derived, not read (Phase 2 fix)

The hero activity pill resolves state via a derived `activityStatus`: agent-level terminal states (`paused`, `pending_approval`, `terminated`) first, then run-array derivation for `running`, then `agent.status` fallback.

**Why.** `agent.status` drifts stale in the React Query cache — the detail query keys on the URL-ref (`conversation-tester`) while the live-event invalidation passes the UUID. Different keys, different caches, no prefix match. Symptom: dashboard activity pill reads "Idle" while the Live Run card reads "Running." Deriving running-ness from the same `runs` array the card trusts sidesteps the cache-coherence gap.

**Lenses.** Mental Models (pill and card must tell one story), Postel's Law (tolerate imperfect backend signals by deriving from always-fresh ones).

### 2.2 Cyan relocated, not preserved at card level (Phase 3a)

The Live Run card no longer renders `border-cyan-500/30` + glow shadow. The activity pill above carries the external liveness signal; the card's internal `StatusIcon` (cyan spinning `Loader2`) carries it locally. Eliminates the three-way cyan duplication that existed in Phase 2 (pill + card border + spinner).

**Lenses.** Von Restorff (isolated chromatic signal must be alone to pop), Information Scent (top-left where the eye lands first per F-pattern is the right home for liveness).

### 2.3 Hero-spanning activity pill (Phase 3a polish round 3)

Option C from a Mode 2 alignment exploration. The pill lifts out of the left zone to a hero-level row above the 75/25 grid, and both primary cards share a baseline.

Three alignment approaches were considered (A: symmetric eyebrows on both zones; B: absorb pill into card; C: hero-spanning header). Option C picked because it is semantically honest (the pill describes the *agent*, not the current-work column), preserves Von Restorff for the cyan signal, has zero structural cost, and handles zero-runs gracefully without conditional complexity.

**Pill-grounding treatment.** `space-y-3` on the hero wrapper (12px) between pill and grid — tight proximity over a visible separator. Gestalt Proximity groups the pill with the grid below without needing a connector line.

**Lenses.** Gestalt Proximity (grounding), Jakob's Law (section-header + grid is conventional), Aesthetic-Usability Effect (restraint over decoration).

### 2.4 Prior-runs compact feed replaces icon strip (Phase 3a polish round 2)

A concept-level revision from the concept §7 icon-strip pattern. The icon strip was compact but information-sparse — run id, outcome detail, and timestamp all required hover to decode. Replaced with three one-line rows below the Latest Run card, each showing colored icon + mono id + status label + relative time. All info visible; no hover required.

**Lenses.** Jakob's Law (feed rows reuse the Latest Run card's anatomy at lower weight), Recognition over Recall (outcomes readable at a glance, not color-only under hover), Information Scent (failed runs announce themselves), Serial Position + Miller's Law (1 primary + 3 secondary = 4 items, well within working memory).

### 2.5 Idle-state "Next up" hint (Phase 3a)

When the activity status is `idle` or `active` (not running), the left zone below the Latest Run card renders either `Next up · <task-id> <title> →` (linking to the top in-flight task) or `No pending work`. Answers "what's supposed to happen next?" — the forward-looking signal the concept §1 flagged as missing.

Data scope: derived from the existing `inFlightTasks` memo. A richer "Next scheduled run in 12m" signal would require fetching routines (`RoutineTrigger.nextRunAt`) — out of scope.

**Lenses.** Goal-Gradient + Zeigarnik (idle agent with pending work surfaces it cheaply), Serial Position (top-priority task earns the hint slot).

### 2.6 Chart consolidation 4 → 1 with success-rate subtitle (Phase 3b)

Dropped `PriorityChart`, `IssueStatusChart`, and `SuccessRateChart` from the dashboard composition; kept `RunActivityChart`. Success rate merged into the chart card's subtitle as `N% success · Last 14 days`.

Dropped charts have 1-interaction reach to their canonical homes:
- Issues by Priority / Status → via in-flight "View all →" link to `/issues?participantAgentId=<id>` + filter.
- Success Rate → visible as subtitle on the surviving card.

Success-rate formula: `succeeded / total` (not `succeeded / (succeeded + failed)`), matching the stacked-bars visual so the caption and the chart agree.

Scope-preserving: `PriorityChart`, `IssueStatusChart`, `SuccessRateChart` are still exported from `ActivityCharts.tsx` for the company-level `pages/Dashboard.tsx` consumer. Only removed from `AgentDetail.tsx` imports and JSX.

**Lenses.** Information Scent (drops only when canonical home is 1 interaction away), Hick's Law + Choice Overload (one chart asks one question), Pareto (run activity is the 20% doing 80% of the monitoring/debug work).

### 2.7 Rich chart tooltips + legend scoped to dashboard usage (Phase 3b polish)

`RunActivityChart` had a pre-existing gap: no legend and only a native-`title` tooltip with daily total (no breakdown). Consolidation raised the chart's prominence, so the gap demanded a fix.

Scope-preserving:
- **Legend**: exported the existing `ChartLegend` helper (was file-private) and rendered it externally inside `ChartCard`. Zero-touch to the shared chart component.
- **Tooltips**: added opt-in `richTooltips?: boolean` prop to `RunActivityChart`. When true, each day column wraps in a shadcn `<Tooltip>` with day + `Succeeded: N · Failed: N · Other: N`. When false (default), native-title behavior preserved. `Dashboard.tsx` unchanged.

The rich-tooltip branch uses a `<button>` as `TooltipTrigger`'s child (not `<div>`) for keyboard focusability.

**Lenses.** Recognition over Recall (legend), Information Scent (breakdown tooltips), Doherty Threshold (shadcn delayDuration=0 vs native ~500ms), Jakob's Law.

### 2.8 Selector over drag for priority affordance (Phase 3c)

Used the existing `PriorityIcon` component's built-in popover picker. Passing `onChange` turns its icon into a shadcn `<Popover>` with 4 keyboard-accessible `<Button>` options. Used in production at `IssueDetail.tsx` and `IssueProperties.tsx`.

**Why selector over drag** (deferred from concept §4):
- Fitts's Law — click-target 16×16 is faster than a drag gesture across four buckets. Priority change is frequent, low-stakes.
- Hick's Law — 4 discrete choices are equivalent whether drag-targets or popover items; popover is more compact.
- Vertical-space cost — drag-to-bucket would need a 4-column Kanban layout, ~250px before any tasks render. Would break the monitoring-no-scroll goal.
- Keyboard accessibility out of the box — popover with 4 `<button>` items is keyboard-navigable without the `@dnd-kit` keyboard-sensor layer.

Optimistic update scoped to `[...queryKeys.issues.list(companyId), "participant-agent", agentId]` — the exact cache slice driving `inFlightTasks` → `assignedIssues`. On error: revert snapshot + shadcn error toast. On settled: invalidate full prefix for convergence.

Brief highlight flash (`bg-accent/30` for 1000ms via local state + existing `transition-colors`) on the changed row. Highlight travels with the row when it repositions by the priority-DESC sort — visual closure for the reposition action.

Click-stopper `<span>` around `PriorityIcon` to prevent the popover-trigger click from bubbling to the EntityRow's parent `<Link>`.

**Lenses.** Reach-for-what-exists-first (PriorityIcon already ships the picker), Jakob's Law (matches IssueDetail pattern), Doherty Threshold (optimistic update <100ms), Causality + Zeigarnik (reposition + highlight closes the loop).

### 2.9 Unified costs module (Phase 3d)

Merged the Phase 0 split (KPI strip + per-run table, two bordered cards) into one bordered container. Summary block (`p-4`) with a one-liner `$X.XX cumulative · N in · N out · N cached` sits above a borderless table; a single `border-t` on the table's `thead` row separates summary from detail.

Title moved inside the module ("Costs — session" as an eyebrow). Matches `ChartCard`'s self-contained pattern; the external `<h3>Costs</h3>` in `AgentOverview` was removed.

Session cost and token totals get one line with differentiated weight (cost at `text-sm font-semibold`, tokens at `text-xs text-muted-foreground`). Middot separators; `flex flex-wrap` for narrow viewports.

Empty states:
- Neither runtime state nor runs-with-cost → one compact card with eyebrow + "No cost data yet."
- Runtime state without runs-with-cost → summary only.
- Runs-with-cost without runtime state → table only. No synthesized summary fallback — session vs all-runs would mix vocabularies.
- Both → both, separated by the table-header border-t.

**Lenses.** Common Region (one bounded area reads as one module), Prägnanz (simpler shape), Progressive Disclosure (glanceable summary, detail below), Information Scent (summary scents to the table), Aesthetic-Usability Effect (single dense line less noisy than 4-cell grid).

### 2.10 Module heading normalization (Phase 4 polish)

All module labels use `text-xs font-medium text-muted-foreground` (the `ChartCard` title pattern). Previously: ChartCard used that pattern; Costs eyebrow was missing `font-medium`; In-flight h3 was `text-sm font-medium` (bigger, not muted). One tier now, visual rhythm cleaner.

**Lens.** Visual restraint (Section 6 of rubric) — one type size for module labels, the page reads as one aesthetic system.

---

## 3. DS deviations — "pass with explicit justification"

Per rubric Section 5: a run that deviates and documents its reasoning passes; silent deviation fails.

### 3.1 `rounded-full` on progress-bar track and activity-dot

Sharp-corners default (`rounded-none`) applies to surfaces. A 2px status dot and a progress-bar fill are glyphs, not surfaces. `rounded-full` is the conventional shape for both and matches existing `BudgetPolicyCard` / `agentStatusDot` usage.

### 3.2 Progress bar colors `bg-red-400 / bg-amber-300 / bg-emerald-300`

Raw-palette classes. Deliberate match to `BudgetPolicyCard`'s treatment so the dashboard progress bar and the Budget tab card read as one family. Switching to `--signal-success` locally would fork the budget visual vocabulary. "No new tokens" policy prevents proposing one.

### 3.3 `bg-cyan-400 animate-pulse` on the activity-state dot

Comes from `agentStatusDot["running"]` — unchanged from Phase 0 baseline, used consistently across the app (Agents list, Design Guide showcase). Deliberate reuse, not new drift.

### 3.4 `PopoverContent` with `rounded-md`

Inherited from the shadcn `Popover` primitive. The dashboard aesthetic is `rounded-none`, but shadcn primitives are an accepted exemption per Step 0 DS policy. Overriding would require local className overrides on every popover usage across the codebase — not scoped to Phase 3c. Same for `Button` inside the popover (likely `rounded-md` from shadcn Button variants).

### 3.5 `bg-accent/30` for the priority-change highlight flash

`bg-accent` is an existing DS token; `/30` opacity is standard Tailwind modifier syntax. No new token, no new raw-palette drift.

### 3.6 `text-cyan-600 / text-red-600` on activity-pill text

Already present in the dashboard region via `runStatusIcons` (`AgentDetail.tsx:104–111`). Reuse of existing palette classes, not new drift.

---

## 4. Findings (not fixed, surfaced for comparison writeup)

Observations that aren't Run A's scope to resolve. Flagged for the post-experiment decision pile.

### 4.1 `agent.status` cache-coherence gap

Root cause behind the Phase 2 "dashboard says Idle while Live Run card says running" bug. The `agent` detail query keys on the URL ref (`conversation-tester`) while `LiveUpdatesProvider.onAgentStatus` invalidates via UUID (`queryKeys.agents.detail(agentId)`). React Query's prefix-match fails; the cached `agent.status` drifts stale during active runs. Derivation (see 2.1) sidesteps the symptom; the underlying gap remains. Fix is out-of-scope for Run A (would touch `LiveUpdatesProvider.tsx` or the query-key shape — both outside the three in-scope functions).

### 4.2 Header/dashboard cyan-vs-blue hue drift

Phase 0 discovery noted that the page-header's mobile-only live indicator uses `bg-blue-400` / `bg-blue-500` while the inline dashboard card used `bg-cyan-400`. After Phase 3a's cyan relocation, the activity pill uses cyan (via `agentStatusDot`), but the header still uses blue. Out of scope for Run A (header is outside the redesign region).

### 4.3 `--signal-warning` missing from the token set

The budget card's warn state uses raw `bg-amber-300` (via `BudgetPolicyCard` pattern). A `--signal-warning` token would make this explicit. Step 0 DS policy prevents proposing new tokens mid-experiment, so we mirror the existing BudgetPolicyCard treatment and flag the gap here.

### 4.4 "Failed task" vs "failed run" terminology gap

Rubric Section 2 Debug says "identify failed *tasks*, see when each one failed." Failed runs are tracked on `HeartbeatRun`; tasks (Issues) don't have a direct failure state. A failed task is usually represented by its failed run, but the mapping isn't tight. Brief-terminology decision for a future iteration.

### 4.5 Per-task cost attribution is weak

`HeartbeatRun` has no reliable link to `Issue` at the type level. The unified costs table shows cost per run (run id + tokens + dollars), but users can't answer "which task consumed the most" from this view. A real per-task rollup would need either an `issueId` on heartbeat runs or a `contextSnapshot` join — both data-model changes. Matters for rubric Section 2 "Accountability (spend)": we serve "which runs were expensive" (engineer) but not "which tasks were expensive" (manager).

### 4.6 `agentStatusDot["idle"]` and `agentStatusDot["paused"]` are both `bg-yellow-400`

Existing DS ambiguity in `status-colors.ts`. Two distinct states, identical dot color. Users reading the label ("Idle" vs "Paused") resolve the ambiguity, but the dot alone isn't state-distinguishing. `status-colors.ts` is explicitly locked by brief — we can't fix.

### 4.7 No client-side permission gate for issue priority edits

The dashboard priority selector matches the existing app pattern (`IssueDetail.tsx`, `IssueProperties.tsx`): any authenticated user can change priority; server-side rejection surfaces via error toast. If product wants tighter client gating, it's a new requirement + a server-side permission check. Deliberate continuity, not silent granting.

### 4.8 Nested-interactive DOM: `<Link>` > `<PopoverTrigger as button>`

On the in-flight task rows, the priority icon's popover trigger sits inside `EntityRow`'s `<Link>`. Screen-reader-visible warning pattern (nested interactive). The existing `EntityRow` component assumes this pattern is acceptable given its `to`-prop contract. Functional impact is minimal — keyboard focus flows correctly, click propagation is stopped — but a11y auditors will flag it. Scoped fix (splitting the row into priority-button + title-link siblings) would remove the row-wide click affordance. Accepted compromise.

### 4.9 "Cumulative session" vs "month-to-date observed" vocabulary overlap

The costs module shows `$X.XX cumulative` (session-lifetime, from `runtimeState.totalCostCents`). The hero budget shows `$A of $B` (calendar-month-to-date observed, from `budgetSummary`). Two cost numbers at different scopes on the same dashboard. Each explicitly labeled ("session" vs "this month"), but legible-but-fragile vocabulary — a user glancing at the dashboard could conflate them.

---

## 5. Deferred items — Phase 4 consciously left alone

### 5.1 Chart sparseness

Chart band at full width has ~80px of bar content inside a wide card. The "thin" impression from Phase 3b polish has been partially resolved by Phase 3d's tighter costs module (below-fold rebalanced). Not densified here because densification adds decoration that Section 6 "Visual restraint" scores against; the chart's job is glanceable, not comprehensive. The subtitle (`N% success`) already carries the summary signal.

### 5.2 Latest Run card right-edge alignment

The hero's 75/25 split creates a visual step between the left-zone's 75% right edge and the full-width modules below. Accepted as deliberate rhythm: the hero's 75/25 is about dividing "now" (current work) from "budget state"; the modules below are about chart / list / costs, none of which share the hero's duality. Different structural treatments for different content. Forcing alignment would require either shrinking the chart/in-flight/costs to 75% (loses module width budget) or expanding the hero to full width with internal re-composition (undoes the 3a alignment work).

### 5.3 Nested-interactive a11y on in-flight rows

See 4.8 above. Considered refactoring the row inline (priority-button + title-link as siblings rather than nested) but the refactor loses whole-row click affordance. Accepted as a compromise matching the existing `EntityRow` pattern.

### 5.4 Chart-bar keyboard tab count (14 stops)

`richTooltips` renders each chart bar as a focusable `<button>` for keyboard-accessible tooltip content. 14 tab stops before a keyboard user can reach the in-flight list below is a lot. Not fixed — the per-day breakdown is a legitimate keyboard-access detail for Section 2 Debug users. Adding `tabIndex={-1}` would remove the keyboard path to the tooltip content.

---

## 6. Rubric alignment

Self-scoring lives in [`run-a-self-check.md`](./run-a-self-check.md), walked item by item with one-sentence reasoning per the rubric's scoring template. The summary:

```
Section 1 (Primary goal):     PASS
Section 2 (Mode coverage):    4 / 4 passed
Section 3 (Actions):          2 / 2 passed
Section 4 (Data):             3 / 3 passed
Section 5 (DS compliance):    8 / 8 passed
                              └─ 4 clean pass + 4 pass-with-justification (§3 above)
Section 6 (Qualitative):      Improvement: 4/5 | Hierarchy: 4/5 | Restraint: 4/5 | Live-run: 4/5
Section 7:                    See self-check
```

Rationale for each score is in `run-a-self-check.md`. Section 6 scores are deliberately conservative — a run that claims 5/5 across the board without acknowledging real tradeoffs is a credibility problem.

---

## 7. Friction log highlights

Full friction log is in the self-check document. Top-three worth capturing for the comparison writeup:

1. **Concept evolves under pressure.** The Phase 0 concept specified a cyan-preserved card, a 55/45 hero, 4-up charts dropped to 1, an icon-strip for recent runs, and a hero pill. The Phase 4 outcome has cyan-relocated (not preserved), 75/25 hero (not 55/45), icon strip replaced by a compact feed, and hero pill promoted to hero-header. Each change was a smoke-test-informed refinement, not a pre-commitment violation. The concept as a document captured *intent*; implementation surfaced *learnings*. Both runs (A and B) are likely to see similar concept drift — it's a feature of the process, not a bug.

2. **Pre-existing gaps surface under consolidation.** The chart legend + rich-tooltip gap was pre-existing on `RunActivityChart` in `ActivityCharts.tsx` — it never had a legend or a proper tooltip. In the 4-up grid, it was easy to miss; as the sole chart, the gap was immediately visible. Run A inherited and fixed it in a scope-preserving way. Run B may encounter similar inherited-gap patterns; worth flagging as a class of finding.

3. **Shared-component boundaries matter.** Three shared-component changes were made: `ChartLegend` exported (additive), `RunActivityChart` got opt-in `richTooltips` (additive, backward-compat), `PriorityIcon` reused unchanged. Each change was deliberately scope-preserving for the other consumer (`pages/Dashboard.tsx`). The inverse pattern — restructuring shared components for a single consumer — would have been easier to write and worse for the codebase. Run B should face similar decisions; the right heuristic is "additive opt-in props > narrowed behavior changes."
