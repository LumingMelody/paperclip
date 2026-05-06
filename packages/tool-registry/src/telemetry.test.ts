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

  it("rotates tool_calls.jsonl when it crosses the size threshold", async () => {
    await writeInstanceConfig("inst-1", { companyId: "company-1" });
    const originalThreshold = process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES;
    process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES = "200";
    try {
      const projectDir = path.join(
        mockHome.value,
        ".paperclip",
        "instances",
        "inst-1",
        "projects",
        "company-1",
        "project-1",
      );
      const baseEntry = {
        ts: "2026-04-30T12:00:00.000Z",
        company: "company-1",
        project: "project-1",
        issue: "CRO-99",
        tool: "lingxing.factSku",
        argsHash: "a".repeat(64),
        status: "success",
        durationMs: 5,
        costUnits: 0,
      } as const;

      await recordToolCall({ ...baseEntry });
      const logPath = path.join(projectDir, "tool_calls.jsonl");
      expect((await fs.stat(logPath)).size).toBeGreaterThan(0);

      await recordToolCall({ ...baseEntry, ts: "2026-04-30T12:00:01.000Z" });

      const dirEntries = await fs.readdir(projectDir);
      const archives = dirEntries.filter(
        (name) => name.startsWith("tool_calls.") && name !== "tool_calls.jsonl" && name.endsWith(".jsonl"),
      );
      expect(archives).toHaveLength(1);

      const active = (await fs.readFile(logPath, "utf8")).trim().split("\n");
      expect(active).toHaveLength(1);
      expect(JSON.parse(active[0]).ts).toBe("2026-04-30T12:00:01.000Z");
    } finally {
      if (originalThreshold === undefined) delete process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES;
      else process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES = originalThreshold;
    }
  });

  it("does not rotate below the threshold", async () => {
    await writeInstanceConfig("inst-1", { companyId: "company-1" });
    const originalThreshold = process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES;
    process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES = "100000";
    try {
      const baseEntry = {
        ts: "2026-04-30T12:00:00.000Z",
        company: "company-1",
        project: "project-1",
        issue: "CRO-99",
        tool: "lingxing.factSku",
        argsHash: "a".repeat(64),
        status: "success",
        durationMs: 5,
        costUnits: 0,
      } as const;
      await recordToolCall({ ...baseEntry });
      await recordToolCall({ ...baseEntry, ts: "2026-04-30T12:00:01.000Z" });

      const dir = path.join(
        mockHome.value,
        ".paperclip",
        "instances",
        "inst-1",
        "projects",
        "company-1",
        "project-1",
      );
      const archives = (await fs.readdir(dir)).filter(
        (n) => n.startsWith("tool_calls.") && n !== "tool_calls.jsonl",
      );
      expect(archives).toEqual([]);
    } finally {
      if (originalThreshold === undefined) delete process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES;
      else process.env.PAPERCLIP_TELEMETRY_ROTATE_BYTES = originalThreshold;
    }
  });
});
