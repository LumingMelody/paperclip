import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { factSku } from "./tools/lingxing/factSku.js";

vi.mock("./tools/lingxing/factSku.js", () => ({
  factSku: vi.fn(async () => ({ asin: "B01N9G3JK7" })),
}));

vi.mock("./tools/lingxing/factOrders.js", () => ({
  factOrders: vi.fn(async () => []),
}));

vi.mock("./tools/meta/toolCallsSearch.js", () => ({
  search: vi.fn(async () => []),
}));

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
  it("prints help without requiring execution context", async () => {
    const output = makeIo();

    await expect(runCli(["--help"], output.io)).resolves.toBe(0);

    expect(output.stdout).toContain("lingxing fact-sku");
    expect(output.stdout).toContain("tool-calls search");
    expect(output.stderr).toBe("");
  });

  it("returns structured JSON errors when context flags are missing", async () => {
    const output = makeIo();

    await expect(runCli(["lingxing", "fact-sku", "--asin", "B01N9G3JK7"], output.io)).resolves.toBe(1);

    expect(JSON.parse(output.stderr) as unknown).toMatchObject({
      error: "ValidationError",
    });
  });

  it("dispatches a valid lingxing fact-sku command with computed context", async () => {
    const output = makeIo();
    vi.mocked(factSku).mockClear();

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

    expect(factSku).toHaveBeenCalledWith(
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
