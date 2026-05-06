import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

const STALE_AGENT_HEARTBEAT_MS = 30 * 60 * 1000;
const DEFAULT_RECONCILER_INTERVAL_MS = 5 * 60_000;

let defaultDb: Db | null = null;

export type AgentStateReconcilerResult = {
  reconciled: number;
};

export type StartAgentStateReconcilerOptions = {
  db?: Db;
  intervalMs?: number;
};

function resolveDb(db?: Db): Db {
  const resolved = db ?? defaultDb;
  if (!resolved) {
    throw new Error("Agent state reconciler database has not been configured");
  }
  return resolved;
}

export type ReconcileStaleAgentsOptions = {
  db?: Db;
  /**
   * Minimum age of `lastHeartbeatAt` before an agent is eligible for auto-recovery.
   * Defaults to 30 minutes during the periodic tick to avoid racing against
   * agents that are momentarily between heartbeats. Pass 0 (e.g. during
   * graceful shutdown) to flip every candidate immediately.
   */
  minStaleMs?: number;
  /**
   * Action recorded in the activity log. Defaults to scheduled-tick wording;
   * shutdown callers should override so post-mortem can distinguish them.
   */
  reasonAction?: string;
};

export async function reconcileStaleAgents(now: Date): Promise<AgentStateReconcilerResult>;
export async function reconcileStaleAgents(
  now: Date,
  opts: ReconcileStaleAgentsOptions,
): Promise<AgentStateReconcilerResult>;
export async function reconcileStaleAgents(
  now: Date,
  opts: ReconcileStaleAgentsOptions = {},
): Promise<AgentStateReconcilerResult> {
  const db = resolveDb(opts.db);
  const minStaleMs = opts.minStaleMs ?? STALE_AGENT_HEARTBEAT_MS;
  const action = opts.reasonAction ?? "agent.auto_recovered_stale_heartbeat";
  // This schema derives an agent's current run from running heartbeat_runs.
  const candidates = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    })
    .from(agents)
    .leftJoin(
      heartbeatRuns,
      and(eq(heartbeatRuns.agentId, agents.id), eq(heartbeatRuns.status, "running")),
    )
    .where(and(eq(agents.status, "running"), isNull(heartbeatRuns.id)));

  let reconciled = 0;

  for (const agent of candidates) {
    // Without lastHeartbeatAt we can't reason about staleness; skip unless the
    // caller explicitly disables the staleness check (minStaleMs === 0).
    if (!agent.lastHeartbeatAt && minStaleMs > 0) continue;

    const staleMs = agent.lastHeartbeatAt
      ? now.getTime() - agent.lastHeartbeatAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (staleMs < minStaleMs) continue;

    const [updated] = await db
      .update(agents)
      .set({
        status: "idle",
        updatedAt: now,
      })
      .where(and(eq(agents.id, agent.id), eq(agents.status, "running")))
      .returning({ id: agents.id });

    if (!updated) continue;

    reconciled += 1;
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: "agent_state_reconciler",
      agentId: agent.id,
      action,
      entityType: "agent",
      entityId: agent.id,
      details: {
        previousStatus: "running",
        newStatus: "idle",
        lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
        staleMinutes: Number.isFinite(staleMs) ? Math.floor(staleMs / 60_000) : null,
      },
    });
  }

  return { reconciled };
}

/**
 * Shutdown variant: flip every running agent with no live heartbeatRun to idle
 * regardless of how recent its lastHeartbeatAt is. Use during graceful server
 * shutdown so the next boot doesn't see "ghost running" agents that the
 * reconciler-tick wouldn't catch for 30 minutes.
 */
export async function reconcileAgentsOnShutdown(
  now: Date,
  opts: { db?: Db } = {},
): Promise<AgentStateReconcilerResult> {
  return reconcileStaleAgents(now, {
    db: opts.db,
    minStaleMs: 0,
    reasonAction: "agent.recovered_on_shutdown",
  });
}

/**
 * Heartbeat-run counterpart to {@link reconcileAgentsOnShutdown}: flip every
 * `heartbeat_runs` row in `running` state to `cancelled` so a graceful shutdown
 * doesn't leave orphaned in-flight runs that nothing will ever finalize.
 *
 * Called from the same shutdown handler. Bounded by a per-call DB write
 * timeout in the caller (3s) so a hung DB cannot block process exit.
 */
export async function cancelOrphanedHeartbeatRunsOnShutdown(
  now: Date,
  opts: { db?: Db } = {},
): Promise<{ cancelled: number }> {
  const db = resolveDb(opts.db);
  const orphans = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.status, "running"));

  if (orphans.length === 0) return { cancelled: 0 };

  const updated = await db
    .update(heartbeatRuns)
    .set({ status: "cancelled", updatedAt: now })
    .where(eq(heartbeatRuns.status, "running"))
    .returning({ id: heartbeatRuns.id });

  for (const orphan of orphans) {
    await logActivity(db, {
      companyId: orphan.companyId,
      actorType: "system",
      actorId: "agent_state_reconciler",
      agentId: orphan.agentId,
      action: "heartbeat_run.cancelled_on_shutdown",
      entityType: "heartbeat_run",
      entityId: orphan.id,
      details: { previousStatus: "running", newStatus: "cancelled" },
    });
  }

  return { cancelled: updated.length };
}

export function startAgentStateReconciler(
  opts: StartAgentStateReconcilerOptions = {},
): { stop: () => void } {
  const db = resolveDb(opts.db);
  defaultDb = db;
  const intervalMs = opts.intervalMs ?? DEFAULT_RECONCILER_INTERVAL_MS;
  let tickInProgress = false;

  const timer = setInterval(() => {
    if (tickInProgress) {
      logger.warn("Skipping stale agent state reconciliation because the previous tick is still running");
      return;
    }

    tickInProgress = true;
    void reconcileStaleAgents(new Date(), { db })
      .then((result) => {
        if (result.reconciled > 0) {
          logger.warn(
            { reconciled: result.reconciled },
            "auto-recovered stale running agents with no active heartbeat run",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "stale agent state reconciliation failed");
      })
      .finally(() => {
        tickInProgress = false;
      });
  }, intervalMs);

  const maybeUnref = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeUnref.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
