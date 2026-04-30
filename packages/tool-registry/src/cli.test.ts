import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it, beforeEach, vi } from "vitest";

const registryMock = vi.hoisted(() => ({
  handler: vi.fn(async () => ({ asin: "B01N9G3JK7" })),
  findToolByCli: vi.fn(),
}));

vi.mock("./telemetry.js", () => ({
  recordToolCall: vi.fn(async () => undefined),
}));

vi.mock("./registry.js", async () => {
  const { z } = await import("zod");
  const descriptor = {
    id: "lingxing.factSku",
    cliSubcommand: "fact-sku",
    source: "lingxing",
    description: "Read Lingxing SKU facts for an Amazon ASIN.",
    readOnly: true as const,
    inputSchema: z
      .object({
        asin: z.string().regex(/^[A-Z0-9]{10}$/),
      })
      .strict(),
    handler: registryMock.handler,
  };
  const toolCallsDescriptor = {
    id: "toolCalls.search",
    cliSubcommand: "search",
    source: "toolCalls",
    description: "Search Paperclip tool-call telemetry for a project.",
    readOnly: true as const,
    inputSchema: z
      .object({
        since: z.string(),
        tool: z.string().optional(),
        issue: z.string().optional(),
      })
      .strict(),
    handler: vi.fn(),
  };
  const tools = [descriptor, toolCallsDescriptor];
  return {
    tools,
    registerTool: vi.fn(),
    findToolById: vi.fn((id: string) => tools.find((tool) => tool.id === id)),
    findToolByCli: registryMock.findToolByCli,
  };
});

const registry = await import("./registry.js");
const { recordToolCall } = await import("./telemetry.js");
const { runCli } = await import("./cli.js");

function makeIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        },
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe("runCli", () => {
  beforeEach(() => {
    vi.mocked(registry.findToolByCli).mockReset();
    vi.mocked(registry.findToolByCli).mockReturnValue(registry.tools[0]);
    registryMock.handler.mockClear();
    vi.mocked(recordToolCall).mockClear();
  });

  it("prints help without requiring execution context", async () => {
    const output = makeIo();

    await expect(runCli(["--help"], output.io)).resolves.toBe(0);

    expect(output.stdout).toContain("lingxing fact-sku");
    expect(output.stdout).toContain("tool-calls search");
    expect(output.stderr).toBe("");
    expect(registry.findToolByCli).not.toHaveBeenCalled();
  });

  it("returns structured JSON errors when context flags are missing", async () => {
    const output = makeIo();

    await expect(runCli(["lingxing", "fact-sku", "--asin", "B01N9G3JK7"], output.io)).resolves.toBe(1);

    expect(JSON.parse(output.stderr) as unknown).toMatchObject({
      error: "ValidationError",
    });
  });

  it("dispatches a valid lingxing fact-sku command through the registry with computed context", async () => {
    const output = makeIo();

    await expect(
      runCli(
        [
          "lingxing",
          "fact-sku",
          "--company",
          "company-1",
          "--project",
          "project-1",
          "--issue",
          "issue-1",
          "--actor",
          "agent",
          "--asin",
          "B01N9G3JK7",
        ],
        output.io,
      ),
    ).resolves.toBe(0);

    expect(registry.findToolByCli).toHaveBeenCalledWith("lingxing", "fact-sku");
    expect(registryMock.handler).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        actor: "agent",
        toolName: "lingxing.factSku",
        argsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      { asin: "B01N9G3JK7" },
    );
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
    expect(JSON.parse(output.stdout) as unknown).toEqual({ asin: "B01N9G3JK7" });
  });

  it.skip("spawn smoke requires pnpm --filter @paperclipai/tool-registry build first", () => {
    if (!existsSync("./dist/cli.js")) return;

    const result = spawnSync(process.execPath, ["./dist/cli.js", "--help"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lingxing fact-sku");
  });
});
