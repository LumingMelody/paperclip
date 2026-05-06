import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { UpstreamError } from "../../errors.js";

/**
 * Parse Anna's action briefs (markdown) into structured JSON.
 *
 * Recognised structure (V1/V2/V3 share this shape):
 *
 *   # <title>                                     <- doc title (H1)
 *   ## Page X — ...                               <- section grouping (ignored for output)
 *   ### Action #2 改向 ...                        <- action header
 *   ### Action #5（新增）：FR Amazon 投入不足     <- action header (alt punctuation)
 *   ### Finding #6（新增、待确认）：DE Meta...     <- finding header
 *
 *   **bold-key**: value                            <- structured field (Owner, Deadline, etc.)
 *   - bullet text `[VERIFIED, source-or-confidence]`  <- claim + evidence annotation
 *
 * The parser does not infer; it surfaces what's literally there. Agents/UIs
 * decide whether to act on the claims.
 */

const BRIEF_DATE_RE = /^\#\s+.+?(\d{4}-\d{2}-\d{2})/m;
const SECTION_RE = /^###\s+(Action|Finding)\s+#(\d+)\b(.*)$/;
const FIELD_RE = /^\*\*(Owner|Deadline|Risk|Risk mitigations|Owner\/Deadline)\*\*\s*[:：]\s*(.+?)(?:\s*\|\s*(?=\*\*)|\s*$)/i;
const CLAIM_RE = /\[(VERIFIED|INFERRED|ASSUMPTION)(?:\s*,\s*([^\]]+))?\]/g;

const inputSchema = z
  .object({
    path: z.string().min(1).max(2048),
  })
  .strict();

const claimSchema = z.object({
  class: z.enum(["VERIFIED", "INFERRED", "ASSUMPTION"]),
  detail: z.string().nullable(),
  context: z.string(),
});

const sectionSchema = z.object({
  kind: z.enum(["action", "finding"]),
  number: z.number().int().nonnegative(),
  title: z.string(),
  owner: z.string().nullable(),
  deadline: z.string().nullable(),
  risk: z.string().nullable(),
  claims: z.array(claimSchema),
  rawBody: z.string(),
});

const outputSchema = z.object({
  briefDate: z.string().nullable(),
  title: z.string(),
  sections: z.array(sectionSchema),
  totalSections: z.number().int().nonnegative(),
});

export type BriefParseInput = z.infer<typeof inputSchema>;
export type BriefParseOutput = z.infer<typeof outputSchema>;
export type BriefSection = z.infer<typeof sectionSchema>;
export type BriefClaim = z.infer<typeof claimSchema>;

function stripTitleSeparators(raw: string): string {
  // Header lines look like "改向：EP-UK 广告 +50%..." or "（新增）：FR Amazon..."
  // Pull the segment after the first colon (Chinese or ASCII) if present; else trim.
  const colonIdx = raw.search(/[:：]/);
  const after = colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
  return after.trim();
}

function extractField(line: string, key: RegExp): string | null {
  // Matches `**Key**: value` possibly continuing through `|`-joined siblings.
  const m = line.match(key);
  return m && m[1] ? m[1].trim() : null;
}

// Multiline `m` flag so `$` matches end-of-line, important when the field is
// the last segment of a `**Owner**: ... | **Deadline**: ... | **Risk**: ...` line.
const OWNER_FIELD = /\*\*Owner\*\*\s*[:：]\s*([^|\n]+?)(?:\s*\||\s*$)/im;
const DEADLINE_FIELD = /\*\*Deadline\*\*\s*[:：]\s*([^|\n]+?)(?:\s*\||\s*$)/im;
const RISK_FIELD = /\*\*Risk(?:\s*mitigations?)?\*\*\s*[:：]\s*([^|\n]+?)(?:\s*\||\s*$)/im;

function findClaims(body: string): BriefClaim[] {
  const claims: BriefClaim[] = [];
  // Split by line so each claim has a useful context excerpt.
  for (const line of body.split("\n")) {
    let m: RegExpExecArray | null;
    const re = new RegExp(CLAIM_RE.source, "g");
    while ((m = re.exec(line)) !== null) {
      claims.push({
        class: m[1] as BriefClaim["class"],
        detail: m[2]?.trim() ?? null,
        context: line.trim(),
      });
    }
  }
  return claims;
}

export function parseBrief(text: string): BriefParseOutput {
  const lines = text.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# ")) ?? "(untitled brief)";
  const briefDateMatch = text.match(BRIEF_DATE_RE);
  const briefDate = briefDateMatch ? briefDateMatch[1] : null;
  const title = titleLine.replace(/^#\s+/, "").trim();

  type Pending = {
    kind: "action" | "finding";
    number: number;
    title: string;
    bodyLines: string[];
  };
  let current: Pending | null = null;
  const sections: BriefSection[] = [];

  const flush = () => {
    if (!current) return;
    const rawBody = current.bodyLines.join("\n").trim();
    sections.push({
      kind: current.kind,
      number: current.number,
      title: current.title,
      owner: extractField(rawBody, OWNER_FIELD),
      deadline: extractField(rawBody, DEADLINE_FIELD),
      risk: extractField(rawBody, RISK_FIELD),
      claims: findClaims(rawBody),
      rawBody,
    });
    current = null;
  };

  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      flush();
      current = {
        kind: m[1].toLowerCase() === "action" ? "action" : "finding",
        number: Number.parseInt(m[2], 10),
        title: stripTitleSeparators(m[3]),
        bodyLines: [],
      };
      continue;
    }
    if (!current) continue;
    // Stop a section at the next H2 (## Page X) — that's section navigation, not body.
    if (/^##\s/.test(line)) {
      flush();
      continue;
    }
    current.bodyLines.push(line);
  }
  flush();

  return { briefDate, title, sections, totalSections: sections.length };
}

async function handleBriefParse(_ctx: ExecutionContext, input: BriefParseInput): Promise<BriefParseOutput> {
  const resolved = path.resolve(input.path);
  let text: string;
  try {
    text = await fs.promises.readFile(resolved, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`failed to read brief at ${resolved}: ${message}`);
  }
  return parseBrief(text);
}

export const briefParseDescriptor: ToolDescriptor<BriefParseInput, BriefParseOutput> = {
  id: "briefs.parse",
  cliSubcommand: "parse",
  source: "briefs",
  description:
    "Parse an Anna-style action brief (.md) into structured sections with claims " +
    "tagged VERIFIED / INFERRED / ASSUMPTION. Read-only — does not create issues.",
  readOnly: true,
  inputSchema,
  outputSchema,
  handler: handleBriefParse,
};
