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

export async function reconcileStaleAgents(now: Date): Promise<AgentStateReconcilerResult>;
export async function reconcileStaleAgents(
  now: Date,
  opts: { db?: Db },
): Promise<AgentStateReconcilerResult>;
export async function reconcileStaleAgents(
  now: Date,
  opts: { db?: Db } = {},
): Promise<AgentStateReconcilerResult> {
  const db = resolveDb(opts.db);
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
    if (!agent.lastHeartbeatAt) continue;

    const staleMs = now.getTime() - agent.lastHeartbeatAt.getTime();
    if (staleMs < STALE_AGENT_HEARTBEAT_MS) continue;

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
  }

  return { reconciled };
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
