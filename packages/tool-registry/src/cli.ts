#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertContext, type ExecutionContext } from "./context.js";
import { errorMessage, classifyError, ValidationError } from "./errors.js";
import { hashArgs } from "./argsHash.js";
import { factOrders } from "./tools/lingxing/factOrders.js";
import { factSku } from "./tools/lingxing/factSku.js";
import { search } from "./tools/meta/toolCallsSearch.js";

interface CliWritable {
  write(chunk: string): unknown;
}

interface CliIo {
  stdout: CliWritable;
  stderr: CliWritable;
}

const helpText = `pcl-tools

Subcommands:
  lingxing fact-sku      --company <c> --project <p> --issue <i> --actor <agent|user|system> --asin <ASIN>
  lingxing fact-orders   --company <c> --project <p> --issue <i> --actor <agent|user|system> --sku-id <SKU> --since <ISO>
  tool-calls search      --company <c> --project <p> --issue <i> --actor <agent|user|system> --since <ISO> [--tool <name>] [--issue-filter <id>]
`;

function stringFlag(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function parseCliArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        company: { type: "string" },
        project: { type: "string" },
        issue: { type: "string" },
        actor: { type: "string" },
        run: { type: "string" },
        asin: { type: "string" },
        "sku-id": { type: "string" },
        since: { type: "string" },
        tool: { type: "string" },
        "issue-filter": { type: "string" },
      },
    });
  } catch (error) {
    throw new ValidationError(errorMessage(error));
  }
}

function buildContext(values: Record<string, unknown>, toolName: string, argsForHash: unknown): ExecutionContext {
  return assertContext({
    companyId: stringFlag(values, "company"),
    projectId: stringFlag(values, "project"),
    issueId: stringFlag(values, "issue"),
    runId: stringFlag(values, "run"),
    actor: stringFlag(values, "actor"),
    toolName,
    argsHash: hashArgs(argsForHash),
  });
}

function writeJson(stream: CliWritable, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function dispatch(positionals: string[], values: Record<string, unknown>): Promise<unknown> {
  const [namespace, command] = positionals;

  if (namespace === "lingxing" && command === "fact-sku") {
    const input = {
      asin: stringFlag(values, "asin"),
    };
    const ctx = buildContext(values, "lingxing.factSku", input);
    return factSku(ctx, input);
  }

  if (namespace === "lingxing" && command === "fact-orders") {
    const input = {
      skuId: stringFlag(values, "sku-id"),
      since: stringFlag(values, "since"),
    };
    const ctx = buildContext(values, "lingxing.factOrders", input);
    return factOrders(ctx, input);
  }

  if (namespace === "tool-calls" && command === "search") {
    const input = {
      since: stringFlag(values, "since"),
      tool: stringFlag(values, "tool"),
      issue: stringFlag(values, "issue-filter"),
    };
    const ctx = buildContext(values, "toolCalls.search", input);
    return search(ctx, input);
  }

  throw new ValidationError(`Unknown subcommand: ${positionals.join(" ") || "(none)"}`);
}

export async function runCli(
  argv = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);
    const values = parsed.values as Record<string, unknown>;
    if (values.help === true) {
      io.stdout.write(helpText);
      return 0;
    }

    const result = await dispatch(parsed.positionals, values);
    writeJson(io.stdout, result);
    return 0;
  } catch (error) {
    writeJson(io.stderr, {
      error: classifyError(error),
      message: errorMessage(error),
    });
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
