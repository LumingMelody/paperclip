import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "./errors.js";
import { recordToolCall } from "./telemetry.js";

vi.mock("./telemetry.js", () => ({
  recordToolCall: vi.fn(async () => undefined),
}));

const { runTool } = await import("./executor.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "lingxing.factSku",
  argsHash: "a".repeat(64),
} as const;

describe("runTool", () => {
  it("records telemetry and returns a successful result", async () => {
    const recordToolCallMock = vi.mocked(recordToolCall);
    recordToolCallMock.mockClear();

    await expect(runTool(ctx, async () => "ok")).resolves.toBe("ok");

    expect(recordToolCallMock).toHaveBeenCalledTimes(1);
    expect(recordToolCallMock.mock.calls[0]?.[0]).toMatchObject({
      company: "company-1",
      project: "project-1",
      issue: "issue-1",
      tool: "lingxing.factSku",
      status: "success",
    });
  });

  it("records error telemetry and rethrows the original error", async () => {
    const recordToolCallMock = vi.mocked(recordToolCall);
    recordToolCallMock.mockClear();
    const error = new UpstreamError("database unavailable");

    await expect(
      runTool(ctx, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(recordToolCallMock).toHaveBeenCalledTimes(1);
    expect(recordToolCallMock.mock.calls[0]?.[0]).toMatchObject({
      status: "error",
      errorClass: "UpstreamError",
    });
  });
});
