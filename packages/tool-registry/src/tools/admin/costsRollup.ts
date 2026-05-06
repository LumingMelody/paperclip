import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import { errorClassNames, UpstreamError } from "../../errors.js";
import type { ToolDescriptor } from "../../registry.js";
import { resolveProjectWorkspace, type ToolCallEntry } from "../../telemetry.js";

/**
 * Aggregate Paperclip tool-call telemetry into a roll-up suitable for
 * "where did the time/budget go this week" questions. Reads the same
 * tool_calls.jsonl that toolCalls.search reads — single source of truth.
 *
 * Group dimensions:
 *   - tool   : per tool id (e.g. lingxing.factSku)
 *   - issue  : per issue identifier (CRO-37 etc.)
 *   - day    : per UTC calendar day
 *   - status : success | error
 */

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/; // accept full ISO or YYYY-MM-DD

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

const inputSchema = z
  .object({
    since: z.string().regex(ISO_LIKE, "since must start with YYYY-MM-DD"),
    until: z.string().regex(ISO_LIKE, "until must start with YYYY-MM-DD").optional(),
    by: z.enum(["tool", "issue", "day", "status"]).optional(),
    tool: z.string().min(1).optional(),
    issue: z.string().min(1).optional(),
  })
  .strict();

const groupSchema = z.object({
  key: z.string(),
  count: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  p50DurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
  totalCostUnits: z.number().nonnegative(),
});

const outputSchema = z.object({
  by: z.enum(["tool", "issue", "day", "status"]),
  groups: z.array(groupSchema),
  totalCalls: z.number().int().nonnegative(),
  totalErrorCalls: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  totalCostUnits: z.number().nonnegative(),
});

export type CostsRollupInput = z.infer<typeof inputSchema>;
export type CostsRollupOutput = z.infer<typeof outputSchema>;
export type CostsRollupGroup = z.infer<typeof groupSchema>;

function dayKey(ts: string): string {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return "(invalid-ts)";
  return new Date(parsed).toISOString().slice(0, 10);
}

function pickKey(entry: ToolCallEntry, by: CostsRollupInput["by"]): string {
  switch (by) {
    case "tool":
      return entry.tool;
    case "issue":
      return entry.issue;
    case "day":
      return dayKey(entry.ts);
    case "status":
      return entry.status;
    default:
      return entry.tool;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.floor(((p / 100) * sorted.length) - 0.0001)));
  return sorted[rank];
}

async function readJsonl(logPath: string): Promise<ToolCallEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err ? (err as { code: unknown }).code : undefined;
    if (code === "ENOENT") return [];
    throw err;
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

export function aggregate(entries: ToolCallEntry[], input: CostsRollupInput): CostsRollupOutput {
  const by = input.by ?? "tool";
  const sinceMs = Date.parse(input.since);
  const untilMs = input.until ? Date.parse(input.until) : Number.POSITIVE_INFINITY;

  const groups = new Map<string, { durations: number[]; count: number; errorCount: number; totalCostUnits: number }>();
  let totalCalls = 0;
  let totalErrorCalls = 0;
  let totalDurationMs = 0;
  let totalCostUnits = 0;

  for (const entry of entries) {
    const t = Date.parse(entry.ts);
    if (Number.isNaN(t) || t < sinceMs || t > untilMs) continue;
    if (input.tool && entry.tool !== input.tool) continue;
    if (input.issue && entry.issue !== input.issue) continue;

    const key = pickKey(entry, by);
    let group = groups.get(key);
    if (!group) {
      group = { durations: [], count: 0, errorCount: 0, totalCostUnits: 0 };
      groups.set(key, group);
    }
    group.count += 1;
    group.durations.push(entry.durationMs);
    group.totalCostUnits += entry.costUnits ?? 0;
    if (entry.status === "error") group.errorCount += 1;

    totalCalls += 1;
    totalDurationMs += entry.durationMs;
    totalCostUnits += entry.costUnits ?? 0;
    if (entry.status === "error") totalErrorCalls += 1;
  }

  const groupRows: CostsRollupGroup[] = Array.from(groups.entries()).map(([key, g]) => {
    const sorted = [...g.durations].sort((a, b) => a - b);
    const total = sorted.reduce((sum, ms) => sum + ms, 0);
    return {
      key,
      count: g.count,
      errorCount: g.errorCount,
      totalDurationMs: total,
      p50DurationMs: percentile(sorted, 50),
      p95DurationMs: percentile(sorted, 95),
      totalCostUnits: g.totalCostUnits,
    };
  });

  // Sort by total duration desc — biggest spenders first.
  groupRows.sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  return { by, groups: groupRows, totalCalls, totalErrorCalls, totalDurationMs, totalCostUnits };
}

async function handleCostsRollup(ctx: ExecutionContext, input: CostsRollupInput): Promise<CostsRollupOutput> {
  let logPath: string;
  try {
    const projectWorkspace = await resolveProjectWorkspace(ctx.companyId, ctx.projectId);
    logPath = path.join(projectWorkspace, "tool_calls.jsonl");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`failed to resolve project workspace: ${message}`);
  }
  const entries = await readJsonl(logPath);
  return aggregate(entries, input);
}

export const costsRollupDescriptor: ToolDescriptor<CostsRollupInput, CostsRollupOutput> = {
  id: "costs.rollup",
  cliSubcommand: "rollup",
  source: "costs",
  description:
    "Aggregate tool_calls.jsonl telemetry by tool / issue / day / status. " +
    "Returns count, error count, total/p50/p95 duration, and total costUnits per group.",
  readOnly: true,
  inputSchema,
  outputSchema,
  handler: handleCostsRollup,
};
