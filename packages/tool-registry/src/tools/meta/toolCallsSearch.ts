import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import { errorClassNames, ValidationError } from "../../errors.js";
import { runTool } from "../../executor.js";
import { resolveProjectWorkspace, type ToolCallEntry } from "../../telemetry.js";

const searchInputSchema = z
  .object({
    since: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO date string"),
    tool: z.string().min(1).optional(),
    issue: z.string().min(1).optional(),
  })
  .strict();

const toolCallEntrySchema = z
  .object({
    ts: z.string(),
    company: z.string(),
    project: z.string(),
    issue: z.string(),
    runId: z.string().optional(),
    tool: z.string(),
    argsHash: z.string(),
    status: z.enum(["success", "error"]),
    durationMs: z.coerce.number(),
    costUnits: z.coerce.number().optional(),
    errorClass: z.enum(errorClassNames).optional(),
  })
  .strict();

export type ToolCallsSearchInput = z.infer<typeof searchInputSchema>;

function parseInput(input: unknown): ToolCallsSearchInput {
  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Invalid toolCalls.search input: ${parsed.error.issues[0]?.message ?? "invalid input"}`);
  }
  return parsed.data;
}

async function readJsonl(logPath: string): Promise<ToolCallEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }

  const entries: ToolCallEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsedJson = JSON.parse(line) as unknown;
      const parsed = toolCallEntrySchema.safeParse(parsedJson);
      if (parsed.success) entries.push(parsed.data);
    } catch {
      continue;
    }
  }
  return entries;
}

export async function search(ctx: ExecutionContext, input: unknown): Promise<ToolCallEntry[]> {
  return runTool(ctx, async () => {
    const parsedInput = parseInput(input);
    const sinceMs = Date.parse(parsedInput.since);
    const projectWorkspace = await resolveProjectWorkspace(ctx.companyId, ctx.projectId);
    const logPath = path.join(projectWorkspace, "tool_calls.jsonl");
    const entries = await readJsonl(logPath);

    return entries
      .filter((entry) => {
        const entryTime = Date.parse(entry.ts);
        if (Number.isNaN(entryTime) || entryTime < sinceMs) return false;
        if (parsedInput.tool && entry.tool !== parsedInput.tool) return false;
        if (parsedInput.issue && entry.issue !== parsedInput.issue) return false;
        return true;
      })
      .slice(0, 1000);
  });
}
