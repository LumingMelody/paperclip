import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileStaleAgents } from "../services/agent-state-reconciler.ts";

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
});
