# B1: Expose RAG as a DingTalk-bot Tool (`rag.searchRefundComments`)

**Status:** Draft for review
**Date:** 2026-05-18
**Owner:** Paperclip RAG + DingTalk bot teams
**Related:**
- Phase 2b-1 GA: `2026-05-18-cn-en-query-translation-design.md`
- Existing DingTalk bot architecture: `docs/guides/everpretty-dingtalk-return-rate-bot.md`

---

## 1. Context & Motivation

Two complementary systems are now in production but unaware of each other:

- **Ever-Pretty DingTalk bot** (`~/PycharmProjects/paperclip-dingtalk-bot/`) — Claude API + 28 SQL-backed tools answering `退货率 / 退货原因 / 销量 / 库存` style questions over MySQL DWS + Lingxing aggregates.
- **Paperclip RAG service** (`services/rag/`, Phase 2b-1 GA at tag `rag-phase2b1-cn-en-ga`) — LightRAG knowledge graph + qwen3-30b synthesis over 380 ingested refund comments. Answers "why are customers complaining" semantic questions including CN→EN translated queries (9/10 HIT).

Today, DingTalk bot users asking "EE02968 这款顾客的真实抱怨是什么" get a SQL `LIKE %{keyword}%` answer from `dws.refundComments` — works for English keywords, misses CN semantic queries entirely. The RAG service has a much better answer but lives at a separate HTTP endpoint that's only reachable from `curl`.

**B1 closes this gap by registering RAG as a single new tool in `tool-registry` so the existing DingTalk bot picks it up via its standard tool-catalog mechanism.**

Out of scope:
- Multi-account RAG (EU/AU/JP) — depends on a separate ingest expansion (B2).
- Returning `chunks[]` for citation — depends on fixing the Phase 1 debt #9 empty-chunks bug (A1). Will be added in a follow-up once A1 ships.
- Throttling / per-issue accounting — current traffic <10 req/min; not yet a problem.

---

## 2. Decisions Locked During Brainstorming

| Question | Decision |
|---|---|
| Tool granularity | **One specific tool**: `rag.searchRefundComments` (not generic `rag.search`) |
| Return shape | **`{answer, meta}` only** — no `chunks[]` for v1 (defer until A1 lands) |
| `shop` parameter | **Required**, but only `"EP-US"` accepted; `PZ-*` / other shops rejected with explicit message |
| Dispatch policy | Semantic / "why" questions → RAG; structured filters / exact lookups → DWS. Encoded in tool description + system-prompt addendum |
| RAG service down | Tool throws `UpstreamError("rag service unreachable: ...")` → tool-registry serializes as `{error: "UpstreamError", errorClass: "UpstreamError", message: "rag service unreachable: ..."}`; system-prompt rule says any error from `rag.*` triggers fallback to `dws.refundComments` |

---

## 3. Architecture

### 3.1 New files

```
packages/tool-registry/src/tools/rag/
├── client.ts                    # HTTP client + RagUnavailable error class
├── client.test.ts               # vitest, mocked fetch
├── searchRefundComments.ts      # ToolDescriptor, zod schemas, handler
└── searchRefundComments.test.ts # vitest
```

Mirrors the existing `tools/dws/` pattern (one `client.ts` + one descriptor file per tool).

### 3.2 Modified files

- `packages/tool-registry/src/registry.ts` — add import + push descriptor to `tools[]`
- `paperclip-dingtalk-bot/llm_dispatcher.py` — (a) append RAG vs DWS dispatch rules to the existing system prompt, (b) one-line change at line 199 to pass `errorClass` through to Claude (see §3.3)
- `paperclip-dingtalk-bot/pcl_runner.py` — preserve `err_class` on `PclToolsError` so it survives to the LLM dispatcher (see §3.3). ~4 added lines, no logic change.

Everything else is untouched:
- `paperclip-dingtalk-bot/main.py`, `formatter.py`, `intents.py` — unchanged
- `services/rag/` — unchanged (the RAG service has the right contract already)

### 3.3 Why pcl_runner.py & llm_dispatcher.py also need a tiny change

The current error chain is:
1. tool handler throws `UpstreamError` →
2. `cli.ts:227` writes `{error: "UpstreamError", message: "..."}` to stderr →
3. **`pcl_runner.py:50`** parses it but then **concatenates** class + message into a single string field on `PclToolsError` →
4. `llm_dispatcher.py:199` returns `{error: "PclToolsError", message: "UpstreamError: rag service unreachable: ..."}` →
5. Claude sees `error="PclToolsError"` for **every** tool error, regardless of root cause.

That means the system-prompt rule "if errorClass=='UpstreamError' fall back" can't actually fire — Claude can't distinguish UpstreamError from ValidationError without parsing the message-prefix string. We fix this in two small edits:

**`pcl_runner.py`** — add `err_class` to `PclToolsError`:
```python
class PclToolsError(RuntimeError):
    def __init__(self, message, stderr="", exit_code=-1, err_class=None):
        super().__init__(message)
        self.stderr = stderr
        self.exit_code = exit_code
        self.err_class = err_class  # NEW

# in invoke():
raise PclToolsError(err_msg, stderr=stderr, exit_code=proc.returncode, err_class=err_class)
#                   ^^^^^^^ just the message, NOT f"{err_class}: {err_msg}"
```

**`llm_dispatcher.py:199`** — surface the class to Claude:
```python
return {"error": e.err_class or "PclToolsError", "message": str(e), "exit_code": e.exit_code}
```

After this, every existing tool (dws/lingxing/...) ALSO benefits — their `UpstreamError`/`ValidationError`/`SecretsNotConfigured` distinctions become visible to Claude for the first time. No existing behaviour is broken — the only Python callers of `PclToolsError` are tested by the existing intent regex path, which doesn't read `error` field.

### 3.3 Runtime data flow

```
钉钉 @ 「EE02968 顾客主要在抱怨什么」
     │
     ▼
ChatbotHandler.process → llm_dispatcher
     │
     ▼ system prompt teaches Claude to pick rag.* for semantic questions
Claude → run_paperclip_tool("rag.searchRefundComments",
                            {shop:"EP-US", query:"EE02968 顾客主要在抱怨什么"})
     │
     ▼ subprocess via pcl_runner (no changes)
pcl-tools rag search-refund-comments --shop EP-US --query "..."
     │
     ▼ HTTP POST 127.0.0.1:9001/search { collection:"refund_comments", query, top_k }
RAG service (Phase 2b-1) → translates CN→EN → LightRAG hybrid → qwen3-30b answer
     │
     ▼ JSON { answer, meta }
tool-registry → parses with outputSchema → returns to Claude
     │
     ▼ Claude integrates answer into the 三段式 reply
DingTalk markdown card
```

---

## 4. Tool Descriptor (TypeScript)

`packages/tool-registry/src/tools/rag/searchRefundComments.ts`:

```typescript
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { ragSearch, RagUnavailable } from "./client.js";
import { UpstreamError } from "../../errors.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;
const SUPPORTED_SHOPS = new Set(["EP-US"]);

const inputSchema = z
  .object({
    shop: z
      .string()
      .regex(SHOP_RE, "shop must look like EP-US, EP-UK, ...")
      .refine(
        (s) => SUPPORTED_SHOPS.has(s),
        // zod v3 passes the raw value to the message callback, not {input:...}
        // (see existing example in tools/admin/registryList.test.ts:55).
        (s) => ({ message: `shop ${s} not yet ingested into RAG; supported: ${[...SUPPORTED_SHOPS].join(", ")}` })
      ),
    query: z.string().min(1).max(500),
    topK: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const metaSchema = z
  .object({
    translation: z.enum(["passthrough", "translated", "fallback"]).nullable().optional(),
    originalQuery: z.string().nullable().optional(),
    translatedQuery: z.string().nullable().optional(),
    translateMs: z.number().nullable().optional(),
    fallbackReason: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const outputSchema = z.object({
  answer: z.string(),
  meta: metaSchema,
});

export type RagSearchRefundCommentsInput = z.infer<typeof inputSchema>;
export type RagSearchRefundCommentsOutput = z.infer<typeof outputSchema>;

async function handler(
  _ctx: ExecutionContext,
  input: RagSearchRefundCommentsInput,
): Promise<RagSearchRefundCommentsOutput> {
  try {
    const r = await ragSearch({
      collection: "refund_comments",
      query: input.query,
      topK: input.topK,
    });
    return outputSchema.parse(r);
  } catch (e) {
    if (e instanceof RagUnavailable) {
      // tool-registry's executor serializes this as
      // {error: "UpstreamError", message: "<msg>", errorClass: "UpstreamError"}.
      // The system prompt instructs Claude to fall back to dws.refundComments
      // on ANY error from rag.* tools, so we don't need a custom error code.
      throw new UpstreamError(`rag service unavailable: ${e.message}`);
    }
    throw e;
  }
}

export const searchRefundCommentsDescriptor: ToolDescriptor<
  RagSearchRefundCommentsInput,
  RagSearchRefundCommentsOutput
> = {
  id: "rag.searchRefundComments",
  cliSubcommand: "search-refund-comments",
  source: "rag",
  description:
    "Semantic search over ingested customer refund comments for a shop, " +
    "augmented by an entity knowledge graph (SKU / styleCode / returnReason / " +
    "size / color). Returns a synthesized Chinese answer based on retrieved " +
    "customer-comment evidence. " +
    "USE FOR: open-ended 'why are customers complaining' / 'what's the real " +
    "issue behind this return-reason code' / 'main complaints for SKU X' " +
    "semantic questions. CN and EN queries both work (CN is auto-translated). " +
    "DO NOT USE FOR: structured filtering (specific orderId, exact SKU+date " +
    "lookups, quantity thresholds) — use dws.refundComments instead. " +
    "ON ERROR: any error class (typically 'UpstreamError' when the RAG " +
    "service is down) means you should retry with dws.refundComments + a " +
    "CN keyword LIKE filter, and note '⚠️ RAG 暂不可用' in the reply. " +
    "CURRENT INGEST: EP-US only, 380 docs (Phase 2a snapshot). " +
    "Other shops will reject at validation.",
  readOnly: true,
  inputSchema,
  outputSchema,
  requiredSecrets: [],
  handler,
};
```

### 4.1 HTTP client

`packages/tool-registry/src/tools/rag/client.ts`:

```typescript
const DEFAULT_BASE = "http://127.0.0.1:9001";
const TIMEOUT_MS = 30_000;

export class RagUnavailable extends Error {}

export interface RagSearchInput {
  collection: string;
  query: string;
  topK?: number;
}

export interface RagSearchOk {
  answer: string;
  meta?: {
    translation?: string | null;
    originalQuery?: string | null;
    translatedQuery?: string | null;
    translateMs?: number | null;
    fallbackReason?: string | null;
  } | null;
}

export async function ragSearch(input: RagSearchInput): Promise<RagSearchOk> {
  const base = process.env.RAG_API_BASE ?? DEFAULT_BASE;
  const url = `${base.replace(/\/+$/, "")}/search`;

  const controller = new AbortController();
  // Keep the abort timer alive through response.json() too — for tiny answers
  // it doesn't matter, but RAG can return ~5KB synthesized markdown and
  // body-read should still respect the wall-clock budget.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collection: input.collection,
        query: input.query,
        top_k: input.topK ?? 10,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new RagUnavailable(`rag /search returned HTTP ${response.status}`);
    }

    return (await response.json()) as RagSearchOk;
  } catch (e: unknown) {
    if (e instanceof RagUnavailable) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new RagUnavailable(`rag service unreachable: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
```

### 4.2 Registration

`packages/tool-registry/src/registry.ts` diff (additive only):

```diff
+ import { searchRefundCommentsDescriptor } from "./tools/rag/searchRefundComments.js";
  ...
  export const tools: ToolDescriptor[] = [
    ...
    factOrdersDescriptor,
+   searchRefundCommentsDescriptor,
    ...
  ];
```

---

## 5. Error Matrix

tool-registry's CLI catches any thrown error and prints `{error: classifyError(e), message: e.message}` to stderr (`cli.ts:227`). With the `pcl_runner.py` + `llm_dispatcher.py` edits from §3.3, Claude receives `{error: "<class name>", message: "..."}` where `<class name>` is one of the 6 fixed values: `SecretsNotConfigured | InstanceLookupFailed | ValidationError | UpstreamError | NotFound | InternalError`.

| Scenario | Tool throws | Claude sees (`error`) | Claude action |
|---|---|---|---|
| Happy path 200 | — | — | integrate `answer` into 三段式 reply |
| RAG service down (`ECONNREFUSED`) | `UpstreamError("rag service unavailable: ...ECONNREFUSED...")` | `"UpstreamError"` | retry `dws.refundComments` + CN LIKE filter, note ⚠️ in reply |
| RAG returns 5xx | `UpstreamError("rag service unavailable: rag /search returned HTTP 502")` | `"UpstreamError"` | same fallback |
| 30s timeout | `UpstreamError("rag service unavailable: ...AbortError...")` | `"UpstreamError"` | same fallback |
| `shop="PZ-US"` | zod ZodError → cli maps to `ValidationError` | `"ValidationError"` | acknowledge & try dws/lingxing instead |
| Empty `query` / >500 chars | zod ZodError → `ValidationError` | `"ValidationError"` | fix args, retry |
| RAG translates but flags `meta.translation="fallback"` | — (returns 200) | answer is usable | use it; mark "⚠️ 翻译降级，召回质量可能下降" in References |

The system-prompt rule keys off `error == "UpstreamError"` plus the tool being a `rag.*` call to trigger fallback. `ValidationError` from rag tools is Claude's own fault (wrong args / unsupported shop) and should NOT trigger blind fallback — Claude should read the message and either fix args or pick a different tool family.

---

## 6. DingTalk Bot System Prompt Changes

Only the system prompt is touched, not the Python code.

### 6.1 Append to the existing chain-tools list (`llm_dispatcher.py:58-63`)

```
- 用户问 OPEN-ENDED「为什么退」、「顾客主要在抱怨什么」、「这个款顾客反馈最大的问题是什么」
  这种**语义/主观**类问题时，优先用 `rag.searchRefundComments`（语义召回 + qwen3 综合，
  返回带顾客原话的中文答案）。对于「列出 SKU=X 在某日期范围的所有退货」「按 quantity > N
  过滤」这种**结构化过滤**问题，仍然走 `dws.refundComments`。
```

### 6.2 New section inserted BEFORE "跨渠道 / 全渠道 GMV 专题"

```
## RAG vs DWS 顾客原话 — 怎么选

`rag.searchRefundComments` 和 `dws.refundComments` 都能拿到顾客评论，但适用场景不同：

|                  | rag.searchRefundComments       | dws.refundComments              |
|------------------|--------------------------------|----------------------------------|
| 输入             | 自然语言 query (中/英)         | 精确 skuPrefix + 时间窗          |
| 召回             | 语义相似 + 知识图谱            | SQL LIKE 字符串匹配              |
| 返回             | 综合后的中文段落（含原话引用） | raw rows                         |
| 适用             | 语义/为什么/主观抱怨           | 列举/过滤/精确定位               |
| 数据范围         | 当前 EP-US 380 条带评论快照    | 全量、实时（T+1）                |
| 失败时           | 报 rag_unavailable，自己降级   | 不会自动降级                     |

### 错误处理流程

1. 语义问题 → 调 `rag.searchRefundComments`
2. 拿到 `{error:"UpstreamError"}` → 立刻改调 `dws.refundComments`，
   带 skuPrefix 和你自己挑的中文关键词，回复末尾标注「⚠️ RAG 服务暂不可用」
3. 拿到 `{error:"ValidationError"}` → 不要盲目降级，读 message 修参数
   再试一次（最常见的是 shop 不在支持列表里 — 就告诉用户该 shop 还没接 RAG）
4. RAG 返回但 `meta.translation == "fallback"` → 照常使用答案，
   在 References 段末尾标注「⚠️ 翻译降级」
5. RAG 答案语言 = 中文，直接放进「## 主因分析」段，
   或拆顾客原话进「## 现状」表
```

### 6.3 Tool catalog auto-pickup

The bot's `build_system_prompt()` renders `{tool_catalog}` from `registry.list` at startup. The descriptor description from §4 is the single source of truth — no separate prompt injection needed for tool selection rules at the "what does this tool do" level.

---

## 7. Testing Strategy

### 7.1 TypeScript unit tests

`tools/rag/client.test.ts`:
- URL construction: default base + env override (`RAG_API_BASE`)
- Trailing slash in base is normalized
- Happy path 200 → returns parsed body
- 503 → `RagUnavailable` with status in message
- Network error (mock fetch rejects) → `RagUnavailable`
- Timeout (mock fetch hangs > 30s with fake timers) → `RagUnavailable` with abort signal
- Non-JSON body → `RagUnavailable`

`tools/rag/searchRefundComments.test.ts`:
- Happy path → `{answer, meta}` passthrough
- `RagUnavailable` from client → `ToolError("rag_unavailable", ...)`
- shop="PZ-US" → zod refine error
- shop="EP-US" + query="" → zod min(1) error
- shop="EP-US" + query of 600 chars → zod max(500) error
- topK clamping (151 rejected, "10" coerced to int)

### 7.2 Python — small additions

New unit test in `paperclip-dingtalk-bot/` for the `err_class` plumbing:
- `test_pcl_runner_preserves_err_class` — mock `subprocess.run` to return stderr `{"error":"UpstreamError","message":"x"}`, assert raised `PclToolsError` has `.err_class == "UpstreamError"` and `str(e) == "x"` (not `"UpstreamError: x"`)
- `test_dispatcher_surfaces_err_class_to_claude` — given `PclToolsError(err_class="UpstreamError", message="x")`, the dict returned by `_execute_meta_call` has `error == "UpstreamError"` (not `"PclToolsError"`)

No RAG-specific Python code exists; everything else is generic infrastructure.

### 7.3 Manual smoke tests

| # | Setup | Action | Expected |
|---|---|---|---|
| M1 | RAG up | DingTalk @bot: "EE02968 这个款顾客主要在抱怨什么" | Claude calls `rag.searchRefundComments`, reply has 三段式 with customer original-text quotes |
| M2 | RAG up | DingTalk @bot: "EE02968 近 14 天退货明细" | Claude calls `dws.refundComments` (structured), not RAG |
| M3 | `kill <rag-pid>` | Same query as M1 | Claude calls RAG → gets `rag_unavailable` → retries `dws.refundComments` → reply ends with "⚠️ RAG 暂不可用" |
| M4 | RAG up, query in pure English | DingTalk @bot: "Top complaints about chest fit on EE02968" | RAG `meta.translation="passthrough"`, answer in Chinese |

---

## 8. Acceptance Criteria

A merge is GA-ready when **all** hold:

1. `pnpm --filter @paperclipai/tool-registry test` is green including the new tests
2. `node packages/tool-registry/dist/cli.js rag search-refund-comments --shop EP-US --query "做工质量"` returns a non-empty `answer`
3. `node packages/tool-registry/dist/cli.js registry list | grep rag.searchRefundComments` shows the tool
4. DingTalk bot restart log shows `rag.searchRefundComments` in the tool catalog
5. Manual smoke tests M1, M2, M3 all pass (M4 nice-to-have)
6. RAG service log (`_logs/rag/`) shows `collection=refund_comments` POST entries originating from the bot during M1/M3 runs
7. Tag: `dingtalk-rag-tool-ga`

---

## 9. Rollback Plan

Severity-tiered:

- **Bug in tool description (Claude picks wrong tool)**: revert the system-prompt commit only. Tool stays registered but Claude won't reach for it. No service restart needed.
- **Bug in handler/client**: revert the tool-registry commits, rebuild (`pnpm --filter @paperclipai/tool-registry build`), restart DingTalk bot.
- **Network/firewall surprise**: `unset RAG_API_BASE` or set it to a known-bad URL — tool will universally return `rag_unavailable` and Claude will fall back to dws.* for all questions until fixed.

No data migration. No persistent state changes.

---

## 10. Resolved Pre-Implementation Verifications

These were open during drafting and have been resolved by reading the source:

- **Error class system**: tool-registry has 6 fixed error classes (`errors.ts:1-8`). No custom `(code, message)` shape; we use the existing `UpstreamError`. Spec text updated throughout.
- **`registry.list` shape**: `tools/admin/registryList.ts` includes `description` verbatim in the output (`toolEntrySchema` line ~13). No truncation; long descriptions are fine.
- **`cliSourceName("rag")`**: `registry.ts:80` regex `/[A-Z]/g` only touches uppercase letters, so lowercase 3-letter `"rag"` passes through unchanged. CLI invocation will be `pcl-tools rag search-refund-comments ...`.
- **Health probe at bot startup**: rejected for v1 (YAGNI). First request will fail loudly if RAG is down and Claude will fall back per system prompt; that's sufficient diagnostic signal.
