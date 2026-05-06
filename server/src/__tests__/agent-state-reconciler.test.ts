import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelOrphanedHeartbeatRunsOnShutdown,
  reconcileAgentsOnShutdown,
  reconcileStaleAgents,
} from "../services/agent-state-reconciler.ts";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

type AgentCandidate = {
  id: string;
  companyId: string;
  lastHeartbeatAt: Date | null;
};

function createDbStub(candidates: AgentCandidate[]) {
  const selectWhere = vi.fn(async () => candidates);
  const selectLeftJoin = vi.fn(() => ({ where: selectWhere }));
  const selectFrom = vi.fn(() => ({ leftJoin: selectLeftJoin }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateReturning = vi.fn(async () => [{ id: "agent-stale" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    db: {
      select,
      update,
    },
    updateSet,
    updateWhere,
  };
}

describe("agent state reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recovers only stale running agents without an active run", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const staleHeartbeat = new Date(now.getTime() - 31 * 60_000);
    const freshHeartbeat = new Date(now.getTime() - 10 * 60_000);
    const dbStub = createDbStub([
      {
        id: "agent-stale",
        companyId: "company-1",
        lastHeartbeatAt: staleHeartbeat,
      },
      {
        id: "agent-fresh",
        companyId: "company-1",
        lastHeartbeatAt: freshHeartbeat,
      },
      {
        id: "agent-no-heartbeat",
        companyId: "company-1",
        lastHeartbeatAt: null,
      },
    ]);

    await expect(reconcileStaleAgents(now, { db: dbStub.db as any })).resolves.toEqual({
      reconciled: 1,
    });

    expect(dbStub.updateSet).toHaveBeenCalledTimes(1);
    expect(dbStub.updateSet).toHaveBeenCalledWith({
      status: "idle",
      updatedAt: now,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({
        companyId: "company-1",
        actorType: "system",
        actorId: "agent_state_reconciler",
        agentId: "agent-stale",
        action: "agent.auto_recovered_stale_heartbeat",
        entityType: "agent",
        entityId: "agent-stale",
        details: {
          previousStatus: "running",
          newStatus: "idle",
          lastHeartbeatAt: staleHeartbeat.toISOString(),
          staleMinutes: 31,
        },
      }),
    );
  });

  it("shutdown variant ignores staleness threshold and flips every candidate", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const staleHeartbeat = new Date(now.getTime() - 31 * 60_000);
    const freshHeartbeat = new Date(now.getTime() - 10 * 60_000);
    const dbStub = createDbStub([
      { id: "agent-stale", companyId: "company-1", lastHeartbeatAt: staleHeartbeat },
      { id: "agent-fresh", companyId: "company-1", lastHeartbeatAt: freshHeartbeat },
      { id: "agent-no-hb", companyId: "company-1", lastHeartbeatAt: null },
    ]);

    await expect(reconcileAgentsOnShutdown(now, { db: dbStub.db as any })).resolves.toEqual({
      reconciled: 3,
    });

    expect(dbStub.updateSet).toHaveBeenCalledTimes(3);
    // Activity log uses the shutdown-specific action so post-mortem can distinguish.
    expect(mockLogActivity).toHaveBeenCalledTimes(3);
    for (const call of mockLogActivity.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({ action: "agent.recovered_on_shutdown" }),
      );
    }
  });

  it("shutdown variant handles agents with null lastHeartbeatAt cleanly", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const dbStub = createDbStub([
      { id: "agent-no-hb", companyId: "company-1", lastHeartbeatAt: null },
    ]);

    await expect(reconcileAgentsOnShutdown(now, { db: dbStub.db as any })).resolves.toEqual({
      reconciled: 1,
    });

    expect(mockLogActivity).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({
        details: expect.objectContaining({
          lastHeartbeatAt: null,
          staleMinutes: null,
        }),
      }),
    );
  });

  it("periodic tick still skips agents with null lastHeartbeatAt", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const dbStub = createDbStub([
      { id: "agent-no-hb", companyId: "company-1", lastHeartbeatAt: null },
    ]);

    await expect(reconcileStaleAgents(now, { db: dbStub.db as any })).resolves.toEqual({
      reconciled: 0,
    });

    expect(dbStub.updateSet).not.toHaveBeenCalled();
  });

  it("cancelOrphanedHeartbeatRunsOnShutdown flips running heartbeat_runs to cancelled", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    const orphans = [
      { id: "run-1", companyId: "company-1", agentId: "agent-1" },
      { id: "run-2", companyId: "company-2", agentId: "agent-2" },
    ];

    // SELECT id, companyId, agentId FROM heartbeat_runs WHERE status='running'
    const selectWhere = vi.fn(async () => orphans);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from: selectFrom }));

    // UPDATE heartbeat_runs SET status='cancelled' ... RETURNING id
    const updateReturning = vi.fn(async () => orphans.map((o) => ({ id: o.id })));
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));

    const db = { select, update };

    await expect(
      cancelOrphanedHeartbeatRunsOnShutdown(now, { db: db as any }),
    ).resolves.toEqual({ cancelled: 2 });

    expect(updateSet).toHaveBeenCalledWith({ status: "cancelled", updatedAt: now });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    for (const call of mockLogActivity.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          action: "heartbeat_run.cancelled_on_shutdown",
          entityType: "heartbeat_run",
          details: expect.objectContaining({
            previousStatus: "running",
            newStatus: "cancelled",
          }),
        }),
      );
    }
  });

  it("cancelOrphanedHeartbeatRunsOnShutdown short-circuits when nothing is running", async () => {
    const selectWhere = vi.fn(async () => []);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from: selectFrom }));
    const update = vi.fn();
    const db = { select, update };

    await expect(
      cancelOrphanedHeartbeatRunsOnShutdown(new Date(), { db: db as any }),
    ).resolves.toEqual({ cancelled: 0 });

    expect(update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
