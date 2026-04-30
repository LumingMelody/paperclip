import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UpstreamError, ValidationError } from "./errors.js";
import { runPythonHelper } from "./subprocess.js";

const echoResponseSchema = z
  .object({
    version: z.literal("1"),
    row: z
      .object({
        op: z.string(),
        helperEnv: z.string(),
      })
      .strict(),
  })
  .strict();

let tempRoot = "";

async function writeHelper(name: string, source: string): Promise<string> {
  const helperPath = path.join(tempRoot, name);
  await fs.writeFile(helperPath, source);
  return helperPath;
}

describe("runPythonHelper", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(tmpdir(), "tool-registry-helper-"));
  });

  afterEach(async () => {
    vi.doUnmock("node:child_process");
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("runs a python helper and validates its successful response", async () => {
    const helperPath = await writeHelper(
      "echo.py",
      [
        "import json, os, sys",
        "payload = json.load(sys.stdin)",
        'print(json.dumps({"version": payload["version"], "row": {"op": payload["op"], "helperEnv": os.environ["HELPER_TOKEN"]}}))',
      ].join("\n"),
    );

    await expect(
      runPythonHelper({
        helperPath,
        request: { version: "1", op: "echo" },
        responseSchema: echoResponseSchema,
        envFromSecrets: { HELPER_TOKEN: "available" },
      }),
    ).resolves.toEqual({
      version: "1",
      row: {
        op: "echo",
        helperEnv: "available",
      },
    });
  });

  it("throws the classified error from a helper error envelope", async () => {
    const helperPath = await writeHelper(
      "error.py",
      [
        "import json, sys",
        'print(json.dumps({"version": "1", "error": "ValidationError", "message": "bad helper input"}))',
        "sys.exit(1)",
      ].join("\n"),
    );

    await expect(
      runPythonHelper({
        helperPath,
        request: { version: "1", op: "fail" },
        responseSchema: echoResponseSchema,
        envFromSecrets: {},
      }),
    ).rejects.toThrow(new ValidationError("bad helper input"));
  });

  it("kills helpers that exceed the timeout", async () => {
    const helperPath = await writeHelper("sleep.py", "import time\ntime.sleep(60)\n");

    await expect(
      runPythonHelper({
        helperPath,
        request: { version: "1", op: "sleep" },
        responseSchema: echoResponseSchema,
        envFromSecrets: {},
        timeoutMs: 200,
      }),
    ).rejects.toThrow(new UpstreamError("python helper timed out after 200ms"));
  });

  it("includes stderr when a non-zero helper exits without an error envelope", async () => {
    const helperPath = await writeHelper(
      "stderr.py",
      ["import sys", 'sys.stderr.write("database exploded")', "sys.exit(2)"].join("\n"),
    );

    await expect(
      runPythonHelper({
        helperPath,
        request: { version: "1", op: "stderr" },
        responseSchema: echoResponseSchema,
        envFromSecrets: {},
      }),
    ).rejects.toThrow(/database exploded/);
  });

  it("spawns python without shell interpolation", async () => {
    class FakeReadable {
      private readonly dataListeners: Array<(chunk: string) => void> = [];

      setEncoding(_encoding: BufferEncoding): void {}

      on(event: "data", listener: (chunk: string) => void): this {
        if (event === "data") this.dataListeners.push(listener);
        return this;
      }

      emitData(chunk: string): void {
        for (const listener of this.dataListeners) listener(chunk);
      }
    }

    class FakeWritable {
      constructor(private readonly onEnd: (chunk: string) => void) {}

      end(chunk: string): void {
        this.onEnd(chunk);
      }
    }

    class FakeChild {
      readonly stdout = new FakeReadable();
      readonly stderr = new FakeReadable();
      readonly stdin = new FakeWritable(() => {
        this.stdout.emitData(
          JSON.stringify({
            version: "1",
            row: {
              op: "echo",
              helperEnv: "available",
            },
          }),
        );
        queueMicrotask(() => this.closeListener?.(0));
      });

      killed = false;
      private closeListener?: (code: number | null) => void;
      private errorListener?: (error: Error) => void;

      kill(_signal?: string): boolean {
        this.killed = true;
        return true;
      }

      once(event: "error", listener: (error: Error) => void): void;
      once(event: "close", listener: (code: number | null) => void): void;
      once(event: "error" | "close", listener: ((error: Error) => void) | ((code: number | null) => void)): void {
        if (event === "error") {
          this.errorListener = listener as (error: Error) => void;
          return;
        }
        this.closeListener = listener as (code: number | null) => void;
      }
    }

    const spawnMock = vi.fn((_command: string, _args: string[], _options: unknown) => new FakeChild());
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));
    vi.resetModules();
    const { runPythonHelper: mockedRunPythonHelper } = await import("./subprocess.js");
    const helperPath = await writeHelper(
      "echo-no-shell.py",
      [
        "import json, os, sys",
        "payload = json.load(sys.stdin)",
        'print(json.dumps({"version": "1", "row": {"op": payload["op"], "helperEnv": os.environ["HELPER_TOKEN"]}}))',
      ].join("\n"),
    );

    await mockedRunPythonHelper({
      helperPath,
      request: { version: "1", op: "echo" },
      responseSchema: echoResponseSchema,
      envFromSecrets: { HELPER_TOKEN: "available" },
    });

    const options = spawnMock.mock.calls.at(-1)?.[2];
    expect(spawnMock).toHaveBeenCalledWith("python3", [helperPath], expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }));
    expect(options).not.toEqual(expect.objectContaining({ shell: true }));
  });
});
