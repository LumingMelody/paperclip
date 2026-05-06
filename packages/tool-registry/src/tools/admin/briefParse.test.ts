import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { briefParseDescriptor, parseBrief } from "./briefParse.js";

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "briefs.parse",
  argsHash: "j".repeat(64),
} as const;

const SAMPLE = `# Ever-Pretty 创始人行动简报 · 2026-04-30 (V3 补丁版)

intro paragraph that should be ignored.

---

## Page 1 — 3 个补丁

### Action #2 改向：EP-UK 广告 +50% 加在 Meta 而不是 Amazon

**新数据** [CRO-37](/CRO/issues/CRO-37) 7 天 pilot:
- **UK Meta ROAS 26.33x** \`[VERIFIED, CRO-37 from xlsx 609725668325271]\`
- **UK Amazon ROAS 11.44x** \`[INFERRED, M]\` GBP→USD×1.27 FX 假设

**新建议**：+50% ($582/天) 加在 Meta。

**预计增量**：$11K–15K/天 \`[ASSUMPTION, L]\` 按现有 ROAS 70% 保守估。

**Owner**: 广告投手 | **Deadline**: 5月5日 | **Risk**: 持续监控 ACOS

---

### Action #5（新增）：FR Amazon 投入不足

**现状数据** [CRO-37]:
- Amazon 日均 **$337** \`[VERIFIED, CRO-37 SQL]\` vs Meta $1,028
- ACOS **7.5%** \`[VERIFIED, CRO-37 xlsx 270040689161643]\`

**Owner**: 广告投手 | **Deadline**: 5月5日 | **Risk**: 若 ACOS > 20% 立即回滑

---

### Finding #6（新增、待确认）：DE Meta 账户为何 0 spend？

- DE Meta 账户 \`1626613425146839\` 7 天内 \`0 spend\` \`[VERIFIED, CRO-37 xlsx]\`
- DE 是唯一 Amazon (31.99x) > Meta(N/A) 的市场

**问题给 Anna**：账户是手动停投，还是配置异常？

---

## Page 2 — 不变项

trailing content not part of any section.
`;

describe("parseBrief", () => {
  it("extracts brief date and title", () => {
    const out = parseBrief(SAMPLE);
    expect(out.briefDate).toBe("2026-04-30");
    expect(out.title).toContain("行动简报");
  });

  it("identifies 3 sections (2 actions + 1 finding)", () => {
    const out = parseBrief(SAMPLE);
    expect(out.totalSections).toBe(3);
    expect(out.sections.map((s) => `${s.kind}#${s.number}`)).toEqual([
      "action#2",
      "action#5",
      "finding#6",
    ]);
  });

  it("strips the colon-prefix from section titles", () => {
    const out = parseBrief(SAMPLE);
    expect(out.sections[0].title).toBe("EP-UK 广告 +50% 加在 Meta 而不是 Amazon");
    expect(out.sections[1].title).toBe("FR Amazon 投入不足");
    expect(out.sections[2].title).toBe("DE Meta 账户为何 0 spend？");
  });

  it("extracts Owner / Deadline / Risk fields when present", () => {
    const out = parseBrief(SAMPLE);
    expect(out.sections[0].owner).toBe("广告投手");
    expect(out.sections[0].deadline).toBe("5月5日");
    expect(out.sections[0].risk).toBe("持续监控 ACOS");
  });

  it("Finding without Owner row leaves owner=null", () => {
    const out = parseBrief(SAMPLE);
    expect(out.sections[2].owner).toBeNull();
    expect(out.sections[2].deadline).toBeNull();
  });

  it("captures all evidence claims with class + detail + context", () => {
    const out = parseBrief(SAMPLE);
    const action2 = out.sections[0];
    // Three claims in Action #2: VERIFIED + INFERRED + ASSUMPTION
    expect(action2.claims).toHaveLength(3);
    const verified = action2.claims.find((c) => c.class === "VERIFIED")!;
    expect(verified.detail).toContain("CRO-37");
    expect(verified.context).toContain("Meta ROAS");
    const inferred = action2.claims.find((c) => c.class === "INFERRED")!;
    expect(inferred.detail).toBe("M");
    const assumption = action2.claims.find((c) => c.class === "ASSUMPTION")!;
    expect(assumption.detail).toBe("L");
  });

  it("stops a section at the next ## header (Page 2 boundary)", () => {
    const out = parseBrief(SAMPLE);
    // Finding #6 should NOT include the "## Page 2" or "trailing content".
    expect(out.sections[2].rawBody).not.toContain("Page 2");
    expect(out.sections[2].rawBody).not.toContain("trailing content");
  });

  it("handles a brief with no sections", () => {
    const out = parseBrief("# Empty brief 2026-01-01\n\nno sections here.\n");
    expect(out.totalSections).toBe(0);
    expect(out.sections).toEqual([]);
    expect(out.briefDate).toBe("2026-01-01");
  });
});

describe("briefs.parse descriptor", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `brief-test-${Date.now()}-${Math.random()}.md`);
    fs.writeFileSync(tmpFile, SAMPLE);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("reads the brief from disk and returns parsed sections", async () => {
    const out = await briefParseDescriptor.handler(ctx, { path: tmpFile });
    expect(out.totalSections).toBe(3);
    expect(out.sections[0].claims.length).toBeGreaterThan(0);
  });

  it("throws UpstreamError when the path is missing", async () => {
    const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.md`);
    await expect(briefParseDescriptor.handler(ctx, { path: missing })).rejects.toThrow(/failed to read/);
  });
});
