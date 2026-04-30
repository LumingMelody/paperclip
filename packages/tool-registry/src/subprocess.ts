import * as childProcess from "node:child_process";
import { z } from "zod";
import {
  InternalError,
  InstanceLookupFailed,
  NotFound,
  SecretsNotConfigured,
  UpstreamError,
  ValidationError,
  errorClassNames,
  type ToolErrorClass,
} from "./errors.js";

export type PythonHelperRequest<P extends Record<string, unknown> = Record<string, never>> = P & {
  version: "1";
  op: string;
};

export interface PythonHelperOptions<I, O> {
  helperPath: string;
  request: I & { version: "1"; op: string };
  responseSchema: z.ZodSchema<O>;
  envFromSecrets: Record<string, string>;
  timeoutMs?: number;
}

const defaultTimeoutMs = 30_000;

const requestSchema = z
  .object({
    version: z.literal("1"),
    op: z.string().min(1),
  })
  .passthrough();

const errorEnvelopeSchema = z
  .object({
    version: z.literal("1").optional(),
    error: z.enum(errorClassNames),
    message: z.string(),
  })
  .passthrough();

interface ChildProcessEvents {
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
}

function classedError(errorClass: ToolErrorClass, message: string): Error {
  if (errorClass === "SecretsNotConfigured") return new SecretsNotConfigured(message);
  if (errorClass === "InstanceLookupFailed") return new InstanceLookupFailed(message);
  if (errorClass === "ValidationError") return new ValidationError(message);
  if (errorClass === "UpstreamError") return new UpstreamError(message);
  if (errorClass === "NotFound") return new NotFound(message);
  return new InternalError(message);
}

function subprocessFailureMessage(code: number | null, stderr: string, stdout: string): string {
  const detail = stderr.trim() || stdout.trim() || "no output";
  return `python helper exited with code ${code ?? "unknown"}: ${detail}`;
}

function timeoutError(timeoutMs: number): UpstreamError {
  return new UpstreamError(`python helper timed out after ${timeoutMs}ms`);
}

export async function runPythonHelper<I, O>(opts: PythonHelperOptions<I, O>): Promise<O> {
  const parsedRequest = requestSchema.safeParse(opts.request);
  if (!parsedRequest.success) {
    throw new ValidationError(
      `Invalid python helper request: ${parsedRequest.error.issues[0]?.message ?? "invalid request"}`,
    );
  }

  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  const child = childProcess.spawn("python3", [opts.helperPath], {
    env: {
      ...process.env,
      ...opts.envFromSecrets,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    signal: controller.signal,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new UpstreamError("python helper did not expose piped stdio");
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  const childEvents = child as unknown as ChildProcessEvents;

  function settle<T>(fn: () => T): T | undefined {
    if (settled) return undefined;
    settled = true;
    if (timeout) clearTimeout(timeout);
    return fn();
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<O>((resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGTERM");
      controller.abort();
    }, timeoutMs);

    childEvents.once("error", (error) => {
      settle(() => {
        if (timedOut) {
          reject(timeoutError(timeoutMs));
          return;
        }
        reject(new UpstreamError(`Failed to start python helper: ${error.message}`));
      });
    });

    childEvents.once("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(timeoutError(timeoutMs));
          return;
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(stdout);
        } catch {
          if (code !== 0) {
            reject(new UpstreamError(subprocessFailureMessage(code, stderr, stdout)));
            return;
          }
          reject(new UpstreamError(`python helper returned invalid JSON: ${stderr.trim() || stdout.trim() || "no output"}`));
          return;
        }

        const parsedError = errorEnvelopeSchema.safeParse(parsedJson);
        if (parsedError.success) {
          reject(classedError(parsedError.data.error, parsedError.data.message));
          return;
        }

        if (code !== 0) {
          reject(new UpstreamError(subprocessFailureMessage(code, stderr, stdout)));
          return;
        }

        const parsedResponse = opts.responseSchema.safeParse(parsedJson);
        if (!parsedResponse.success) {
          reject(
            new UpstreamError(
              `python helper returned an unexpected response shape: ${
                parsedResponse.error.issues[0]?.message ?? "invalid response"
              }`,
            ),
          );
          return;
        }

        resolve(parsedResponse.data);
      });
    });

    child.stdin.end(JSON.stringify(opts.request));
  });
}
