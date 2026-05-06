import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { UpstreamError } from "../../errors.js";

/**
 * Default path to the platform decisions log. Override via PAPERCLIP_DECISIONS_PATH.
 * decisions.log is a plain-text file at the repo root; entries are headed by
 * `[YYYY-MM-DD ...]` and separated by `=====` divider lines.
 */
const DEFAULT_DECISIONS_PATH = "/Users/melodylu/PycharmProjects/paperclip/decisions.log";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    since: z.string().regex(ISO_DATE, "since must be YYYY-MM-DD").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const entrySchema = z.object({
  date: z.string(),
  title: z.string(),
  body: z.string(),
});

const outputSchema = z.object({
  entries: z.array(entrySchema),
  total: z.number().int().nonnegative(),
});

export type DecisionsSearchInput = z.infer<typeof inputSchema>;
export type DecisionsSearchOutput = z.infer<typeof outputSchema>;
export type DecisionEntry = z.infer<typeof entrySchema>;

/**
 * Parse the decisions log into entries. Two header styles supported:
 *
 *   1) Single-line:   [YYYY-MM-DD HH:MM] inline body text...
 *   2) Multi-line:    [YYYY-MM-DD title]
 *                     =========...
 *                     body lines
 *
 * Any line that starts with `[YYYY-MM-DD` is treated as the start of a new entry.
 * The bracketed segment becomes the title (date stripped); whatever follows the
 * closing `]` on the same line is prepended to the body. Subsequent lines belong
 * to the body until the next header or EOF. A divider line (^=+$) immediately
 * after a header is consumed.
 */
export function parseDecisions(text: string): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  // Captures: [date-token, rest-inside-brackets, rest-of-line]
  const headerRe = /^\[(\d{4}-\d{2}-\d{2})([^\]]*)\](.*)$/;
  const lines = text.split("\n");
  type Pending = { date: string; title: string; bodyLines: string[]; awaitingDivider: boolean };
  let current: Pending | null = null;

  const flush = () => {
    if (!current) return;
    entries.push({
      date: current.date,
      title: current.title || "(untitled)",
      body: current.bodyLines.join("\n").trim(),
    });
    current = null;
  };

  for (const line of lines) {
    const match = headerRe.exec(line);
    if (match) {
      flush();
      const insideBrackets = (match[2] ?? "").trim();
      const afterBrackets = (match[3] ?? "").trim();
      current = {
        date: match[1],
        title: insideBrackets,
        bodyLines: afterBrackets ? [afterBrackets] : [],
        awaitingDivider: !afterBrackets,
      };
      continue;
    }
    if (!current) continue;
    if (current.awaitingDivider) {
      current.awaitingDivider = false;
      if (/^=+$/.test(line.trim())) continue;
    }
    current.bodyLines.push(line);
  }
  flush();
  return entries;
}

async function handleDecisionsSearch(
  _ctx: ExecutionContext,
  input: DecisionsSearchInput,
): Promise<DecisionsSearchOutput> {
  const filePath = process.env.PAPERCLIP_DECISIONS_PATH || DEFAULT_DECISIONS_PATH;
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`failed to read decisions log at ${path.resolve(filePath)}: ${message}`);
  }
  const all = parseDecisions(text);
  const queryLc = input.query?.toLowerCase();
  const filtered = all.filter((entry) => {
    if (input.since && entry.date < input.since) return false;
    if (queryLc) {
      const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
      if (!haystack.includes(queryLc)) return false;
    }
    return true;
  });
  // Most recent first; preserve original order within same date.
  filtered.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const limit = input.limit ?? 20;
  const limited = filtered.slice(0, limit);
  return { entries: limited, total: filtered.length };
}

export const decisionsSearchDescriptor: ToolDescriptor<DecisionsSearchInput, DecisionsSearchOutput> = {
  id: "decisions.search",
  cliSubcommand: "search",
  source: "decisions",
  description:
    "Search the platform architecture decisions log (decisions.log) by substring and/or date. " +
    "Useful for recovering 'why did we choose X' rationale.",
  readOnly: true,
  inputSchema,
  outputSchema,
  handler: handleDecisionsSearch,
};
