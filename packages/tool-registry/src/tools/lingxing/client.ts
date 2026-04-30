import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorClassNames, SecretsNotConfigured, UpstreamError, type ToolErrorClass } from "../../errors.js";
import { loadCompanySecrets } from "../../secrets.js";

export type LingxingQueryRequest =
  | {
      op: "factSku";
      asin: string;
    }
  | {
      op: "factOrders";
      skuId: string;
      since: string;
    };

const connectionSecretsSchema = z.object({
  host: z.string().min(1),
  port: z.string().regex(/^\d+$/).optional(),
  user: z.string().min(1),
  password: z.string(),
  database: z.string().min(1),
});

const errorResponseSchema = z.object({
  error: z.enum(errorClassNames),
  message: z.string(),
});

interface ChildProcessEvents {
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
}

function formatSpawnFailure(code: number | null, stderr: string, stdout: string): string {
  const detail = stderr.trim() || stdout.trim() || "no output";
  return `Lingxing python helper exited with code ${code ?? "unknown"}: ${detail}`;
}

function classedError(errorClass: ToolErrorClass, message: string): Error {
  if (errorClass === "SecretsNotConfigured") return new SecretsNotConfigured(message);
  return new UpstreamError(message);
}

export async function queryLingxing(companyId: string, request: LingxingQueryRequest): Promise<unknown> {
  const secrets = await loadCompanySecrets(companyId, "lingxing");
  const parsedSecrets = connectionSecretsSchema.safeParse(secrets);
  if (!parsedSecrets.success) {
    throw new SecretsNotConfigured(
      `Lingxing credentials for company ${companyId} must include host, user, password, and database`,
    );
  }

  const helperPath = fileURLToPath(new URL("./_query.py", import.meta.url));
  const child = spawn("python3", [helperPath], {
    env: {
      ...process.env,
      LINGXING_DB_HOST: parsedSecrets.data.host,
      LINGXING_DB_PORT: parsedSecrets.data.port ?? "",
      LINGXING_DB_USER: parsedSecrets.data.user,
      LINGXING_DB_PASSWORD: parsedSecrets.data.password,
      LINGXING_DB_DATABASE: parsedSecrets.data.database,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const childEvents = child as unknown as ChildProcessEvents;

  return new Promise<unknown>((resolve, reject) => {
    childEvents.once("error", (error) => {
      reject(new UpstreamError(`Failed to start Lingxing python helper: ${error.message}`));
    });
    childEvents.once("close", (code) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new UpstreamError(formatSpawnFailure(code, stderr, stdout)));
        return;
      }

      const parsedError = errorResponseSchema.safeParse(parsed);
      if (parsedError.success) {
        reject(classedError(parsedError.data.error, parsedError.data.message));
        return;
      }

      if (code !== 0) {
        reject(new UpstreamError(formatSpawnFailure(code, stderr, stdout)));
        return;
      }

      resolve(parsed);
    });

    child.stdin.end(JSON.stringify(request));
  });
}
