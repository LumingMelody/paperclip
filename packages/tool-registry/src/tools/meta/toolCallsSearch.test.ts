import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../errors.js";

const mockHome = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

const { search } = await import("./toolCallsSearch.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-search",
  actor: "agent",
  toolName: "toolCalls.search",
  argsHash: "c".repeat(64),
} as const;

async function writeFixture(lines: unknown[]): Promise<void> {
  const instanceRoot = path.join(mockHome.value, ".paperclip", "instances", "inst-1");
  const projectRoot = path.join(instanceRoot, "projects", "company-1", "project-1");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(instanceRoot, "config.json"), JSON.stringify({ companies: ["company-1"] }));
  await fs.writeFile(path.join(projectRoot, "tool_calls.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("toolCalls.search", () => {
  beforeEach(async () => {
    mockHome.value = await fs.mkdtemp(path.join(tmpdir(), "tool-registry-search-"));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it("filters JSONL telemetry by since, tool, and issue", async () => {
    await writeFixture([
      {
        ts: "2026-04-29T23:00:00.000Z",
        company: "company-1",
        project: "project-1",
        issue: "issue-1",
        tool: "lingxing.factSku",
        argsHash: "a".repeat(64),
        status: "success",
        durationMs: 4,
      },
      {
        ts: "2026-04-30T01:00:00.000Z",
        company: "company-1",
        project: "project-1",
        issue: "issue-2",
        tool: "lingxing.factSku",
        argsHash: "b".repeat(64),
        status: "success",
        durationMs: 5,
      },
      {
        ts: "2026-04-30T02:00:00.000Z",
        company: "company-1",
        project: "project-1",
        issue: "issue-2",
        tool: "lingxing.factOrders",
        argsHash: "c".repeat(64),
        status: "error",
        durationMs: 6,
        errorClass: "UpstreamError",
      },
    ]);

    await expect(
      search(ctx, {
        since: "2026-04-30T00:00:00.000Z",
        tool: "lingxing.factSku",
        issue: "issue-2",
      }),
    ).resolves.toMatchObject([
      {
        issue: "issue-2",
        tool: "lingxing.factSku",
      },
    ]);
  });

  it("throws ValidationError for invalid search dates", async () => {
    await writeFixture([]);

    await expect(search(ctx, { since: "not-a-date" })).rejects.toThrow(ValidationError);
  });
});
