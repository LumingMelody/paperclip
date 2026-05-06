#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertContext, type ExecutionContext } from "./context.js";
import { errorMessage, classifyError, ValidationError } from "./errors.js";
import { hashArgs } from "./argsHash.js";
import { runTool } from "./executor.js";
import { findToolByCli, tools as registeredTools, type ToolDescriptor } from "./registry.js";

interface CliWritable {
  write(chunk: string): unknown;
}

interface CliIo {
  stdout: CliWritable;
  stderr: CliWritable;
}

type ParseArgsOptions = NonNullable<ParseArgsConfig["options"]>;

function stringFlag(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function parseCliArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: buildCliOptions(registeredTools),
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

const contextFlags = new Set(["actor", "company", "help", "issue", "project", "run"]);
const cliInputAliases: Record<string, string> = {
  "issue-filter": "issue",
};

function cliSourceName(source: string): string {
  return source.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();
}

function inputKeyToFlag(key: string): string {
  if (key === "issue") return "issue-filter";
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function schemaKeys(desc: ToolDescriptor): string[] {
  // Walk through ZodEffects (.refine/.transform wrappers) to find the underlying object shape.
  let node: unknown = desc.inputSchema;
  for (let i = 0; i < 5; i += 1) {
    const candidate = node as {
      shape?: Record<string, unknown>;
      _def?: {
        shape?: Record<string, unknown> | (() => Record<string, unknown>);
        schema?: unknown;
        innerType?: unknown;
      };
    };
    const shape =
      candidate.shape ??
      (typeof candidate._def?.shape === "function" ? candidate._def.shape() : candidate._def?.shape);
    if (shape && typeof shape === "object") return Object.keys(shape);
    if (candidate._def?.schema) {
      node = candidate._def.schema;
      continue;
    }
    if (candidate._def?.innerType) {
      node = candidate._def.innerType;
      continue;
    }
    break;
  }
  return [];
}

function inputFlags(desc: ToolDescriptor): string[] {
  return schemaKeys(desc).map(inputKeyToFlag);
}

function buildCliOptions(toolList: ToolDescriptor[]): ParseArgsOptions {
  const options: ParseArgsOptions = {
    help: { type: "boolean", short: "h" },
    company: { type: "string" },
    project: { type: "string" },
    issue: { type: "string" },
    actor: { type: "string" },
    run: { type: "string" },
  };
  for (const desc of toolList) {
    for (const flag of inputFlags(desc)) {
      options[flag] = { type: "string" };
    }
  }
  return options;
}

function buildHelpText(toolList: ToolDescriptor[]): string {
  const lines = ["pcl-tools", "", "Subcommands:"];
  for (const desc of toolList) {
    const flags = inputFlags(desc).map((flag) => `--${flag} <value>`).join(" ");
    lines.push(
      `  ${cliSourceName(desc.source)} ${desc.cliSubcommand} --company <c> --project <p> --issue <i> --actor <agent|user|system>${
        flags ? ` ${flags}` : ""
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function flagToInputKey(flag: string): string {
  return cliInputAliases[flag] ?? flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function buildRawInput(values: Record<string, unknown>): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (contextFlags.has(key) || typeof value !== "string") continue;
    input[flagToInputKey(key)] = value;
  }
  return input;
}

function parseToolInput(desc: ToolDescriptor, rawInput: unknown): unknown {
  const parsed = desc.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(`Invalid ${desc.id} input: ${parsed.error.issues[0]?.message ?? "invalid input"}`);
  }
  return parsed.data;
}

async function dispatch(positionals: string[], values: Record<string, unknown>): Promise<unknown> {
  const [source, subcommand] = positionals;
  if (!source || !subcommand) {
    throw new ValidationError(`Unknown subcommand: ${positionals.join(" ") || "(none)"}`);
  }

  const desc = findToolByCli(source, subcommand);
  if (!desc) {
    throw new ValidationError(`Unknown subcommand: ${positionals.join(" ") || "(none)"}`);
  }

  const rawInput = buildRawInput(values);
  const ctx = buildContext(values, desc.id, rawInput);
  return runTool(ctx, async () => desc.handler(ctx, parseToolInput(desc, rawInput)));
}

export async function runCli(
  argv = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);
    const values = parsed.values as Record<string, unknown>;
    if (values.help === true) {
      io.stdout.write(buildHelpText(registeredTools));
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
