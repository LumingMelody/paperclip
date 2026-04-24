import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentStartLockForTest } from "../services/heartbeat.ts";

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a stale start lock freeze later queued-run starts", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const firstStart = vi.fn(() => new Promise<void>(() => undefined));
    const secondStart = vi.fn(async () => "started");

    void withAgentStartLockForTest(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withAgentStartLockForTest(agentId, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });
});
