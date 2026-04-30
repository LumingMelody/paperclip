import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceLookupFailed } from "./errors.js";

const mockHome = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

const { recordToolCall, resolveProjectWorkspace } = await import("./telemetry.js");

async function writeInstanceConfig(instanceId: string, config: unknown): Promise<void> {
  const instanceRoot = path.join(mockHome.value, ".paperclip", "instances", instanceId);
  await fs.mkdir(instanceRoot, { recursive: true });
  await fs.writeFile(path.join(instanceRoot, "config.json"), JSON.stringify(config));
}

describe("telemetry", () => {
  beforeEach(async () => {
    mockHome.value = await fs.mkdtemp(path.join(tmpdir(), "tool-registry-telemetry-"));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it("appends a tool call entry to the resolved project JSONL log", async () => {
    await writeInstanceConfig("inst-1", { companies: ["company-1"] });

    await recordToolCall({
      ts: "2026-04-30T00:00:00.000Z",
      company: "company-1",
      project: "project-1",
      issue: "issue-1",
      tool: "lingxing.factSku",
      argsHash: "a".repeat(64),
      status: "success",
      durationMs: 3,
      costUnits: 0,
    });

    const logPath = path.join(
      mockHome.value,
      ".paperclip",
      "instances",
      "inst-1",
      "projects",
      "company-1",
      "project-1",
      "tool_calls.jsonl",
    );
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]) as unknown).toMatchObject({
      company: "company-1",
      project: "project-1",
      tool: "lingxing.factSku",
      status: "success",
    });
  });

  it("fails when company instance lookup is ambiguous", async () => {
    await writeInstanceConfig("inst-1", { companyId: "company-1" });
    await writeInstanceConfig("inst-2", { companyId: "company-1" });

    await expect(resolveProjectWorkspace("company-1", "project-1")).rejects.toThrow(InstanceLookupFailed);
  });
});
