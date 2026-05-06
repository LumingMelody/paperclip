import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decisionsSearchDescriptor, parseDecisions } from "./decisionsSearch.js";

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "decisions.search",
  argsHash: "h".repeat(64),
} as const;

const SAMPLE = `
[2026-04-30 Tool registry architecture (Phase 1)]
================================================
Decisions:
- Location: packages/tool-registry
- Surface: CLI pcl-tools

[2026-04-30 mid-loop] Fix: lingxing helper engine pymssql → pymysql
==================================================================
Issue: dispatch prompt assumed lingxing data lived on SQL Server.
Verified reality: EP warehouse is MySQL on Tencent Cloud.
Fix: switch _query.py to pymysql; SELECT TOP 1 → LIMIT 1.

[2026-04-30 evening] Tool registry Phase 2 architecture
========================================================
Outcome: Accepted Codex pushback in full.

[2026-04-29 Server hardening Task A] verifier hook on issue close
=================================================================
Hook fires verifier.ts as subprocess on close transition.
`;

describe("parseDecisions", () => {
  it("parses four entries from the sample", () => {
    const entries = parseDecisions(SAMPLE);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      date: "2026-04-30",
      title: "Tool registry architecture (Phase 1)",
    });
    // Single-line variant: title from inside brackets, body from rest of the line
    expect(entries[1].title).toBe("mid-loop");
    expect(entries[1].body).toContain("pymssql → pymysql");
  });

  it("strips the divider line right after a multi-line header", () => {
    const entries = parseDecisions(SAMPLE);
    expect(entries[0].body).not.toMatch(/^=+/);
    expect(entries[0].body).toContain("Decisions:");
  });

  it("handles entries with no body", () => {
    const entries = parseDecisions("[2026-01-01 Empty entry]\n");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("");
  });

  it("ignores text before the first header", () => {
    const entries = parseDecisions("preamble line that should be ignored\n[2026-01-02 First]\nbody");
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe("2026-01-02");
    expect(entries[0].body).toBe("body");
  });

  it("supports the older single-line [date time] inline-body format", () => {
    const text = "[2026-04-27 17:18] CRO-21 + CRO-22 done. EP-UK > EP-DE.\n";
    const entries = parseDecisions(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe("2026-04-27");
    expect(entries[0].title).toBe("17:18");
    expect(entries[0].body).toBe("CRO-21 + CRO-22 done. EP-UK > EP-DE.");
  });
});

describe("decisions.search descriptor", () => {
  let tmpFile: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `decisions-test-${Date.now()}-${Math.random()}.log`);
    fs.writeFileSync(tmpFile, SAMPLE);
    originalPath = process.env.PAPERCLIP_DECISIONS_PATH;
    process.env.PAPERCLIP_DECISIONS_PATH = tmpFile;
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    if (originalPath === undefined) delete process.env.PAPERCLIP_DECISIONS_PATH;
    else process.env.PAPERCLIP_DECISIONS_PATH = originalPath;
  });

  it("returns all entries sorted most-recent-first when no filter", async () => {
    const out = await decisionsSearchDescriptor.handler(ctx, { limit: 20 });
    expect(out.total).toBe(4);
    expect(out.entries.map((e) => e.date)).toEqual([
      "2026-04-30",
      "2026-04-30",
      "2026-04-30",
      "2026-04-29",
    ]);
  });

  it("filters by query substring (case-insensitive)", async () => {
    const out = await decisionsSearchDescriptor.handler(ctx, { query: "PYMYSQL", limit: 20 });
    expect(out.total).toBe(1);
    // Body holds the substring (single-line entry style); title is the bracket content.
    expect(`${out.entries[0].title}\n${out.entries[0].body}`).toContain("pymssql → pymysql");
  });

  it("filters by since date", async () => {
    const out = await decisionsSearchDescriptor.handler(ctx, { since: "2026-04-30", limit: 20 });
    expect(out.total).toBe(3);
    expect(out.entries.every((e) => e.date >= "2026-04-30")).toBe(true);
  });

  it("respects limit", async () => {
    const out = await decisionsSearchDescriptor.handler(ctx, { limit: 2 });
    expect(out.total).toBe(4);
    expect(out.entries).toHaveLength(2);
  });

  it("throws UpstreamError when the file is missing", async () => {
    process.env.PAPERCLIP_DECISIONS_PATH = path.join(os.tmpdir(), "definitely-does-not-exist.log");
    await expect(decisionsSearchDescriptor.handler(ctx, { limit: 5 })).rejects.toThrow(/failed to read/);
  });
});
