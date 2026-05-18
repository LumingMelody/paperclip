# B1: RAG as DingTalk-bot Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `rag.searchRefundComments` in `tool-registry` so the production Ever-Pretty DingTalk bot can call the Phase 2b-1 RAG service over HTTP via its standard tool-catalog mechanism.

**Architecture:** New `tools/rag/` directory in tool-registry with one HTTP client + one descriptor. A 4-line fix to `pcl_runner.py` + `llm_dispatcher.py` preserves the underlying tool error class through to Claude so dispatch rules can key off `error == "UpstreamError"` for graceful RAG→DWS fallback. System prompt addendum teaches Claude when to pick RAG vs DWS.

**Tech Stack:** TypeScript 5 + vitest 3 (tool-registry); Python 3.13 + pytest (DingTalk bot, first-time setup); Node 24 native `fetch` (no undici dep).

**Spec:** `docs/superpowers/specs/2026-05-18-rag-as-dingtalk-tool-design.md`

**Working dirs for `Run:` commands:**
- Tasks 1-2: `/Users/melodylu/PycharmProjects/paperclip-dingtalk-bot/`
- Tasks 3-6, 8: `/Users/melodylu/PycharmProjects/paperclip/` (repo root) — note that the tool-registry package lives at `packages/tool-registry/`
- Task 7: `/Users/melodylu/PycharmProjects/paperclip-dingtalk-bot/`

Two separate git repos are touched. Each commits to its own master/main.

---

## File Map

**Created (tool-registry, TS):**
- `packages/tool-registry/src/tools/rag/client.ts` — HTTP fetch wrapper + `RagUnavailable` error
- `packages/tool-registry/src/tools/rag/client.test.ts` — vitest unit tests for the client
- `packages/tool-registry/src/tools/rag/searchRefundComments.ts` — `ToolDescriptor` with zod schemas + handler
- `packages/tool-registry/src/tools/rag/searchRefundComments.test.ts` — vitest unit tests for the handler

**Modified (tool-registry, TS):**
- `packages/tool-registry/src/registry.ts` — add import + push descriptor

**Modified (DingTalk bot, Python):**
- `paperclip-dingtalk-bot/pcl_runner.py` — extend `PclToolsError` with `err_class` attribute
- `paperclip-dingtalk-bot/llm_dispatcher.py` — (a) surface `err_class` to Claude; (b) append RAG vs DWS dispatch addendum to system prompt
- `paperclip-dingtalk-bot/requirements-dev.txt` — NEW, just `pytest>=8.0`
- `paperclip-dingtalk-bot/tests/__init__.py` — NEW, empty
- `paperclip-dingtalk-bot/tests/test_pcl_runner.py` — NEW
- `paperclip-dingtalk-bot/tests/test_llm_dispatcher_err_class.py` — NEW

---

### Task 1: Plumb `err_class` through `PclToolsError`

The DingTalk bot's `pcl_runner.py` currently concatenates the tool's error class and message into a single string (`f"{err_class}: {err_msg}"`), so Claude only ever sees `error == "PclToolsError"`. Add an `err_class` attribute that survives to the dispatcher.

**Files:**
- Modify: `paperclip-dingtalk-bot/pcl_runner.py` (the `PclToolsError` class definition and the `invoke()` function)
- Create: `paperclip-dingtalk-bot/requirements-dev.txt`
- Create: `paperclip-dingtalk-bot/tests/__init__.py` (empty file)
- Create: `paperclip-dingtalk-bot/tests/test_pcl_runner.py`

- [ ] **Step 1: Add pytest as a dev dep + create empty tests package**

Create `paperclip-dingtalk-bot/requirements-dev.txt` with:
```
pytest>=8.0
```

Create empty `paperclip-dingtalk-bot/tests/__init__.py`.

Run: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && uv pip install -r requirements-dev.txt`
Expected: pytest installed; no errors.

- [ ] **Step 2: Write the failing tests**

Create `paperclip-dingtalk-bot/tests/test_pcl_runner.py`:

```python
"""Unit tests for pcl_runner.PclToolsError + error class plumbing."""
from __future__ import annotations

import json
from unittest.mock import patch, MagicMock

import pytest

import pcl_runner


def _proc(returncode: int, stdout: str = "", stderr: str = "") -> MagicMock:
    p = MagicMock()
    p.returncode = returncode
    p.stdout = stdout
    p.stderr = stderr
    return p


def test_pcl_runner_preserves_err_class_from_stderr_json():
    """When pcl-tools exits non-zero and stderr is a JSON {error, message},
    the resulting PclToolsError must expose `err_class` and a clean message
    (NOT 'UpstreamError: msg' concatenated)."""
    stderr_body = json.dumps({"error": "UpstreamError", "message": "rag unreachable"})
    fake = _proc(returncode=1, stderr=stderr_body)

    with patch("subprocess.run", return_value=fake):
        with pytest.raises(pcl_runner.PclToolsError) as exc_info:
            pcl_runner.invoke("rag", "search-refund-comments", [("--shop", "EP-US")])

    err = exc_info.value
    assert err.err_class == "UpstreamError"
    assert str(err) == "rag unreachable"
    assert err.exit_code == 1


def test_pcl_runner_unparseable_stderr_leaves_err_class_none():
    """When stderr isn't JSON, err_class stays None (legacy behaviour preserved)."""
    fake = _proc(returncode=2, stderr="some non-JSON crash output", stdout="")

    with patch("subprocess.run", return_value=fake):
        with pytest.raises(pcl_runner.PclToolsError) as exc_info:
            pcl_runner.invoke("rag", "search-refund-comments", [])

    assert exc_info.value.err_class is None
    assert "some non-JSON crash output" in str(exc_info.value)


def test_pcl_runner_happy_path_returns_parsed_stdout():
    """Confirm we didn't break the success path."""
    fake = _proc(returncode=0, stdout=json.dumps({"answer": "hi"}))

    with patch("subprocess.run", return_value=fake):
        out = pcl_runner.invoke("rag", "search-refund-comments", [])

    assert out == {"answer": "hi"}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && python -m pytest tests/test_pcl_runner.py -v`
Expected: `test_pcl_runner_preserves_err_class_from_stderr_json` FAILS with `AttributeError: 'PclToolsError' object has no attribute 'err_class'` (or the assertion on `str(err)` fails because of `f"{err_class}: {err_msg}"` concatenation).

- [ ] **Step 4: Modify `PclToolsError` and `invoke()`**

In `paperclip-dingtalk-bot/pcl_runner.py`, replace the existing `PclToolsError` class and the relevant lines of `invoke()`:

```python
class PclToolsError(RuntimeError):
    """pcl-tools returned non-zero or unparseable output."""

    def __init__(self, message: str, stderr: str = "", exit_code: int = -1,
                 err_class: str | None = None) -> None:
        super().__init__(message)
        self.stderr = stderr
        self.exit_code = exit_code
        self.err_class = err_class
```

Inside `invoke()`, replace the existing `if proc.returncode != 0:` block:

```python
    if proc.returncode != 0:
        try:
            parsed = json.loads(stderr or stdout)
            err_class = parsed.get("error", "InternalError")
            err_msg = parsed.get("message", "")
            raise PclToolsError(
                err_msg or err_class,
                stderr=stderr,
                exit_code=proc.returncode,
                err_class=err_class,
            )
        except (json.JSONDecodeError, AttributeError):
            raise PclToolsError(
                f"pcl-tools exit {proc.returncode}: {stderr or stdout[:300]}",
                stderr=stderr,
                exit_code=proc.returncode,
            )
```

(Note: the message is now just `err_msg` — no `f"{err_class}: {err_msg}"` concatenation. The class survives separately in `err.err_class`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && python -m pytest tests/test_pcl_runner.py -v`
Expected: 3 passed.

- [ ] **Step 6: Commit (in the DingTalk bot repo)**

Run:
```bash
cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot
git add pcl_runner.py requirements-dev.txt tests/__init__.py tests/test_pcl_runner.py
git commit -m "feat(bot): preserve err_class on PclToolsError + add pytest"
```

---

### Task 2: Surface `err_class` to Claude in `llm_dispatcher.py`

After Task 1, `PclToolsError.err_class` exists but the dispatcher still returns `{"error": "PclToolsError", ...}` always. Pipe the class through.

**Files:**
- Modify: `paperclip-dingtalk-bot/llm_dispatcher.py:199`
- Create: `paperclip-dingtalk-bot/tests/test_llm_dispatcher_err_class.py`

- [ ] **Step 1: Write the failing test**

Create `paperclip-dingtalk-bot/tests/test_llm_dispatcher_err_class.py`:

```python
"""Verify llm_dispatcher reports the underlying tool error class to Claude."""
from __future__ import annotations

from unittest.mock import patch

import pytest

import llm_dispatcher
import pcl_runner


def test_dispatcher_surfaces_upstream_error_class():
    """A PclToolsError carrying err_class='UpstreamError' must be surfaced
    to Claude as {error: 'UpstreamError', ...}, NOT 'PclToolsError'."""
    raise_exc = pcl_runner.PclToolsError(
        "rag service unavailable: ECONNREFUSED 127.0.0.1:9001",
        stderr="",
        exit_code=1,
        err_class="UpstreamError",
    )

    with patch.object(pcl_runner, "invoke_by_args", side_effect=raise_exc):
        result = llm_dispatcher._execute_meta_call(
            '{"tool_id": "rag.searchRefundComments", "args": {"shop": "EP-US", "query": "x"}}',
            by_id={"rag.searchRefundComments": {"source": "rag", "cliSubcommand": "search-refund-comments"}},
            issue_id="DINGTALK-test",
        )

    assert result["error"] == "UpstreamError"
    assert "rag service unavailable" in result["message"]


def test_dispatcher_falls_back_to_PclToolsError_when_no_class():
    """Legacy unparseable failures keep the old 'PclToolsError' tag."""
    raise_exc = pcl_runner.PclToolsError(
        "pcl-tools exit 137: <oom>",
        stderr="",
        exit_code=137,
        err_class=None,
    )

    with patch.object(pcl_runner, "invoke_by_args", side_effect=raise_exc):
        result = llm_dispatcher._execute_meta_call(
            '{"tool_id": "dws.refundComments", "args": {"shop": "EP-US", "since": "2026-05-04"}}',
            by_id={"dws.refundComments": {"source": "dws", "cliSubcommand": "refund-comments"}},
            issue_id="DINGTALK-test",
        )

    assert result["error"] == "PclToolsError"
```

- [ ] **Step 2: Inspect `_execute_meta_call` to confirm the test-fixture shape matches**

Run: `sed -n '180,210p' /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot/llm_dispatcher.py`

Find the `_execute_meta_call` function. Confirm it takes `(arguments_json: str, by_id: dict, issue_id: str)` (the test fixture). If the signature differs (e.g. by_id values are `ToolDescriptor` dataclasses not plain dicts), adjust the fixture to match — pass minimal stub objects that have `.source` and `.cliSubcommand` attributes via a `types.SimpleNamespace` or similar. Do NOT change the function signature itself.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && python -m pytest tests/test_llm_dispatcher_err_class.py -v`
Expected: `test_dispatcher_surfaces_upstream_error_class` FAILS with `assert "PclToolsError" == "UpstreamError"`.

- [ ] **Step 4: Update line 199**

In `paperclip-dingtalk-bot/llm_dispatcher.py`, change the one line that returns the error dict:

```python
    except pcl_runner.PclToolsError as e:
        return {"error": e.err_class or "PclToolsError", "message": str(e), "exit_code": e.exit_code}
```

(Existing line: `return {"error": "PclToolsError", "message": str(e), "exit_code": e.exit_code}` — only the `"error"` value changes.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && python -m pytest tests/test_llm_dispatcher_err_class.py tests/test_pcl_runner.py -v`
Expected: 5 passed (3 from Task 1 + 2 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot
git add llm_dispatcher.py tests/test_llm_dispatcher_err_class.py
git commit -m "feat(bot): surface PclToolsError.err_class to Claude"
```

---

### Task 3: RAG HTTP client + `RagUnavailable`

**Files:**
- Create: `packages/tool-registry/src/tools/rag/client.ts`
- Create: `packages/tool-registry/src/tools/rag/client.test.ts`

- [ ] **Step 1: Create the directory**

Run: `mkdir -p packages/tool-registry/src/tools/rag`

- [ ] **Step 2: Write the failing tests**

Create `packages/tool-registry/src/tools/rag/client.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ragSearch, RagUnavailable } from "./client.js";

const realFetch = globalThis.fetch;

describe("ragSearch", () => {
  beforeEach(() => {
    delete process.env.RAG_API_BASE;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RAG_API_BASE;
  });

  it("posts to /search at the default base and returns parsed JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ answer: "hi", meta: { translation: "translated" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await ragSearch({ collection: "refund_comments", query: "做工", topK: 5 });

    expect(out.answer).toBe("hi");
    expect(out.meta?.translation).toBe("translated");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9001/search");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ collection: "refund_comments", query: "做工", top_k: 5 });
  });

  it("honors RAG_API_BASE env override and strips trailing slashes", async () => {
    process.env.RAG_API_BASE = "http://rag.internal:8000/";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ answer: "x" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ragSearch({ collection: "c", query: "q" });

    expect(fetchMock.mock.calls[0]![0]).toBe("http://rag.internal:8000/search");
  });

  it("defaults top_k to 10 when not provided", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ answer: "x" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ragSearch({ collection: "c", query: "q" });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.top_k).toBe(10);
  });

  it("throws RagUnavailable on non-2xx HTTP", async () => {
    globalThis.fetch = vi.fn(async () => new Response("oops", { status: 502 })) as unknown as typeof fetch;

    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(RagUnavailable);
    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(/HTTP 502/);
  });

  it("throws RagUnavailable on network error (fetch rejects)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("ECONNREFUSED 127.0.0.1:9001");
    }) as unknown as typeof fetch;

    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(RagUnavailable);
    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws RagUnavailable when body is not JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>not json</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(ragSearch({ collection: "c", query: "q" })).rejects.toThrow(RagUnavailable);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/tool-registry exec vitest run src/tools/rag/client.test.ts`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 4: Create the client**

Create `packages/tool-registry/src/tools/rag/client.ts`:

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

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/tool-registry exec vitest run src/tools/rag/client.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit (paperclip repo)**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
git add packages/tool-registry/src/tools/rag/client.ts packages/tool-registry/src/tools/rag/client.test.ts
git commit -m "feat(tool-registry): add RAG HTTP client + RagUnavailable error"
```

---

### Task 4: `rag.searchRefundComments` descriptor

**Files:**
- Create: `packages/tool-registry/src/tools/rag/searchRefundComments.ts`
- Create: `packages/tool-registry/src/tools/rag/searchRefundComments.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/tool-registry/src/tools/rag/searchRefundComments.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { UpstreamError, ValidationError } from "../../errors.js";

vi.mock("./client.js", () => ({
  ragSearch: vi.fn(),
  RagUnavailable: class RagUnavailable extends Error {},
}));

const { searchRefundCommentsDescriptor } = await import("./searchRefundComments.js");
const { ragSearch, RagUnavailable } = await import("./client.js");

const ctx = {
  companyId: "company-1",
  projectId: "project-1",
  issueId: "issue-1",
  actor: "agent",
  toolName: "rag.searchRefundComments",
  argsHash: "r".repeat(64),
} as const;

describe("rag.searchRefundComments descriptor", () => {
  it("registers as id rag.searchRefundComments with kebab cliSubcommand", () => {
    expect(searchRefundCommentsDescriptor.id).toBe("rag.searchRefundComments");
    expect(searchRefundCommentsDescriptor.source).toBe("rag");
    expect(searchRefundCommentsDescriptor.cliSubcommand).toBe("search-refund-comments");
    expect(searchRefundCommentsDescriptor.requiredSecrets).toEqual([]);
  });

  it("rejects unsupported shops via zod refine", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "PZ-US",
      query: "hi",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/not yet ingested/);
      expect(r.error.issues[0].message).toMatch(/EP-US/);
    }
  });

  it("rejects malformed shop pattern", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "notashop",
      query: "hi",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty query", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "EP-US",
      query: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects query longer than 500 chars", () => {
    const r = searchRefundCommentsDescriptor.inputSchema.safeParse({
      shop: "EP-US",
      query: "x".repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it("happy path returns parsed RAG response", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({
      answer: "顾客抱怨胸围",
      meta: { translation: "translated", translateMs: 412 },
    });

    const out = await searchRefundCommentsDescriptor.handler(ctx as any, {
      shop: "EP-US",
      query: "胸围紧",
    });

    expect(out.answer).toBe("顾客抱怨胸围");
    expect(out.meta?.translation).toBe("translated");
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "胸围紧",
      topK: undefined,
    });
  });

  it("forwards topK when provided", async () => {
    vi.mocked(ragSearch).mockResolvedValueOnce({ answer: "x" });
    await searchRefundCommentsDescriptor.handler(ctx as any, {
      shop: "EP-US",
      query: "x",
      topK: 25,
    });
    expect(ragSearch).toHaveBeenCalledWith({
      collection: "refund_comments",
      query: "x",
      topK: 25,
    });
  });

  it("wraps RagUnavailable as UpstreamError", async () => {
    vi.mocked(ragSearch).mockRejectedValueOnce(
      new (RagUnavailable as any)("rag /search returned HTTP 503"),
    );

    await expect(
      searchRefundCommentsDescriptor.handler(ctx as any, {
        shop: "EP-US",
        query: "x",
      }),
    ).rejects.toThrow(UpstreamError);

    await expect(
      searchRefundCommentsDescriptor.handler(ctx as any, {
        shop: "EP-US",
        query: "x",
      }),
    ).rejects.toThrow(/rag service unavailable.*HTTP 503/);
  });

  it("does NOT wrap unknown errors as UpstreamError", async () => {
    vi.mocked(ragSearch).mockRejectedValueOnce(new TypeError("totally unexpected"));

    await expect(
      searchRefundCommentsDescriptor.handler(ctx as any, {
        shop: "EP-US",
        query: "x",
      }),
    ).rejects.toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/tool-registry exec vitest run src/tools/rag/searchRefundComments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the descriptor**

Create `packages/tool-registry/src/tools/rag/searchRefundComments.ts`:

```typescript
import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";
import { UpstreamError } from "../../errors.js";
import { ragSearch, RagUnavailable } from "./client.js";

const SHOP_RE = /^(EP|PZ|DAMA)-[A-Z]{2}$/;
const SUPPORTED_SHOPS = new Set(["EP-US"]);

const inputSchema = z
  .object({
    shop: z
      .string()
      .regex(SHOP_RE, "shop must look like EP-US, EP-UK, PZ-US, DAMA-US, etc.")
      .refine(
        (s) => SUPPORTED_SHOPS.has(s),
        (s) => ({
          message: `shop ${s} not yet ingested into RAG; supported: ${[...SUPPORTED_SHOPS].join(", ")}`,
        }),
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/tool-registry exec vitest run src/tools/rag/searchRefundComments.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
git add packages/tool-registry/src/tools/rag/searchRefundComments.ts packages/tool-registry/src/tools/rag/searchRefundComments.test.ts
git commit -m "feat(tool-registry): add rag.searchRefundComments tool descriptor"
```

---

### Task 5: Register in `registry.ts`

**Files:**
- Modify: `packages/tool-registry/src/registry.ts`

- [ ] **Step 1: Read the existing registry to find correct insertion points**

Run: `sed -n '1,30p' packages/tool-registry/src/registry.ts`
Run: `sed -n '44,75p' packages/tool-registry/src/registry.ts`

- [ ] **Step 2: Add the import**

In `packages/tool-registry/src/registry.ts`, after line 16 (which is `import { skusByReasonDescriptor } from "./tools/dws/skusByReason.js";`), add:

```typescript
import { searchRefundCommentsDescriptor } from "./tools/rag/searchRefundComments.js";
```

- [ ] **Step 3: Push descriptor onto `tools[]` array**

In the `export const tools: ToolDescriptor[] = [...]` array, append `searchRefundCommentsDescriptor` to the existing list (after the last entry, before the closing `]`):

```typescript
  costsRollupDescriptor,
  searchRefundCommentsDescriptor,
];
```

- [ ] **Step 4: Verify tool-registry build still passes**

Run: `pnpm --filter @paperclipai/tool-registry exec tsc --noEmit`
Expected: zero errors.

Run: `pnpm --filter @paperclipai/tool-registry test`
Expected: all tests pass (new RAG tests + all pre-existing tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
git add packages/tool-registry/src/registry.ts
git commit -m "feat(tool-registry): register rag.searchRefundComments"
```

---

### Task 6: Build + CLI smoke test against live RAG service

**Files:** none (no code changes; build + manual verification)

- [ ] **Step 1: Build the package**

Run: `pnpm --filter @paperclipai/tool-registry build`
Expected: produces `packages/tool-registry/dist/`. No TypeScript errors.

- [ ] **Step 2: Verify the tool appears in registry list**

Run: `node packages/tool-registry/dist/cli.js registry list --company company-1 --project project-1 --issue B1-smoke --actor cli | grep rag.searchRefundComments`
Expected: a line containing `"id": "rag.searchRefundComments"` and `"source": "rag"`.

- [ ] **Step 3: Confirm RAG service is up**

Run: `curl -s http://127.0.0.1:9001/healthz`
Expected: JSON like `{"status":"ok","lm_studio":"up","collections":[...]}`.

If RAG is not up, restart it: `cd services/rag && ./scripts/run_dev.sh > /tmp/rag.log 2>&1 &`

- [ ] **Step 4: CLI smoke test — happy path**

Run:
```bash
node packages/tool-registry/dist/cli.js rag search-refund-comments \
  --company company-1 --project project-1 --issue B1-smoke --actor cli \
  --shop EP-US --query "做工质量"
```
Expected: JSON like `{"answer": "<Chinese paragraph about workmanship issues>", "meta": {"translation": "translated", ...}}` printed to stdout. Exit code 0.

- [ ] **Step 5: CLI smoke test — unsupported shop**

Run:
```bash
node packages/tool-registry/dist/cli.js rag search-refund-comments \
  --company company-1 --project project-1 --issue B1-smoke --actor cli \
  --shop PZ-US --query "做工质量"
```
Expected: non-zero exit. stderr contains `"error":"ValidationError"` and the message names `EP-US` as supported.

- [ ] **Step 6: CLI smoke test — RAG service down (UpstreamError path)**

Kill RAG temporarily: `pkill -f "uvicorn paperclip_rag" || true`

Wait 2 seconds. Then run the same happy-path command from Step 4.
Expected: non-zero exit. stderr contains `"error":"UpstreamError"` and the message contains `rag service unavailable`.

Restart RAG: `cd services/rag && ./scripts/run_dev.sh > /tmp/rag.log 2>&1 &`
Wait until `curl -s http://127.0.0.1:9001/healthz` returns ok.

- [ ] **Step 7: Commit (just an empty marker commit if needed, otherwise skip)**

No code changes in this task. Proceed.

---

### Task 7: System prompt addendum for RAG vs DWS dispatch

**Files:**
- Modify: `paperclip-dingtalk-bot/llm_dispatcher.py` (the system-prompt template constant near the top)

- [ ] **Step 1: Locate the current 退货分析 section**

Run: `sed -n '47,70p' /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot/llm_dispatcher.py`

This shows the existing `## 退货分析专题输出规范` block ending around line 63 with the chain-tools bullet list.

- [ ] **Step 2: Append the new RAG bullet to the chain-tools list**

Find the line currently at approximately `llm_dispatcher.py:62-63`:
```python
- 用户问"Top SKUs by 偏小 / 偏大 / 颜色 / 面料 / 质量 ..."这种**按特定 reason 排序的 SKU**问题时
  必须用 `dws.skusByReason`（不要用 returnsBySku 然后过滤——会漏掉非主因 SKU）
```

After it (still inside the same triple-quoted system prompt string), add:
```python
- 用户问 OPEN-ENDED「为什么退」、「顾客主要在抱怨什么」、「这个款顾客反馈最大的问题是什么」
  这种**语义/主观**类问题时，优先用 `rag.searchRefundComments`
  （它做语义召回 + qwen3 综合，返回带顾客原话的中文答案）。
  对于「列出 SKU=X 在某日期范围的所有退货」「按 quantity > N 过滤」
  这种**结构化过滤**问题，仍然走 `dws.refundComments`。
```

- [ ] **Step 3: Insert the new RAG vs DWS comparison section**

Find the line `## 跨渠道 / 全渠道 GMV 专题` (currently around line 65-66) and insert the following ENTIRE block BEFORE it (still inside the triple-quoted system prompt string):

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
| 失败时           | 报 UpstreamError，自己降级     | 不会自动降级                     |

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

- [ ] **Step 4: Sanity-check the file still parses**

Run: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && python -c "import llm_dispatcher; print(llm_dispatcher.SYSTEM_PROMPT_TEMPLATE[:200])"`
Expected: prints the first 200 chars of the system prompt without exception.

(If the constant is named differently than `SYSTEM_PROMPT_TEMPLATE` — check `grep -n "SYSTEM_PROMPT\|system_prompt" llm_dispatcher.py` — adjust the import target. Goal is just to confirm the file is valid Python after the edit.)

- [ ] **Step 5: Run all bot tests still pass**

Run: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && python -m pytest tests/ -v`
Expected: 5 passed (Tasks 1 + 2 tests still green).

- [ ] **Step 6: Commit**

```bash
cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot
git add llm_dispatcher.py
git commit -m "feat(bot): system prompt — RAG vs DWS dispatch rules for refund queries"
```

---

### Task 8: Restart bot + manual smoke tests + tag

**Files:** none (manual verification + git tags in both repos)

- [ ] **Step 1: Confirm both services are up**

Run: `curl -s http://127.0.0.1:9001/healthz` → expect `lm_studio:"up"`.
Run: `lsof -nP -iTCP -sTCP:LISTEN | grep dingtalk` (best-effort check that bot process is alive — DingTalk uses outbound stream so port check may not apply; alternatively `pgrep -fl 'paperclip-dingtalk-bot/main.py'`).

- [ ] **Step 2: Restart the DingTalk bot to pick up new tool catalog + system prompt**

If launchd: `launchctl kickstart -k gui/$UID/com.everpretty.paperclip-dingtalk-bot`
Else: `cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot && ./run.sh > /tmp/bot.log 2>&1 &`

Wait 5 seconds. Confirm bot is up: `tail -30 /tmp/bot.log` (or whichever log file). Look for a line indicating the tool catalog includes `rag.searchRefundComments`. If the bot's startup log doesn't list tools, send the bot the message `查工具` in DingTalk and confirm `rag.searchRefundComments` appears in the returned list.

- [ ] **Step 3: Smoke test M1 — happy path semantic query**

In a DingTalk group where the bot is present, send: `@小助手 EE02968 这个款顾客主要在抱怨什么`

Expected:
- Reply uses the 三段式 format (现状 / 主因分析 / 建议).
- The 主因分析 段 contains specific customer feedback quoted or paraphrased from the RAG answer.
- `via rag.searchRefundComments` (or similar attribution) appears at the end.

- [ ] **Step 4: Smoke test M2 — structured query stays on DWS**

Send: `@小助手 EE02968 近 14 天的退货明细`

Expected:
- Reply is built from `dws.refundComments` or `dws.returnDetail`, NOT `rag.searchRefundComments`.
- Attribution line confirms which tool was used.

- [ ] **Step 5: Smoke test M3 — RAG service down → fallback**

`pkill -f "uvicorn paperclip_rag" || true`

Wait 3 seconds. Send the same M1 query again: `@小助手 EE02968 这个款顾客主要在抱怨什么`

Expected:
- Reply still arrives (no 5xx to user).
- Body ends with `⚠️ RAG 服务暂不可用` (or close paraphrase).
- Attribution shows `dws.refundComments`.

Restart RAG: `cd services/rag && ./scripts/run_dev.sh > /tmp/rag.log 2>&1 &`

- [ ] **Step 6: Verify RAG log received bot traffic**

Run: `grep -E 'collection=refund_comments|/search' /tmp/rag.log | tail -5`
Expected: see POST /search lines for the M1 and M5-recovery queries.

- [ ] **Step 7: Tag both repos**

```bash
# paperclip repo
cd /Users/melodylu/PycharmProjects/paperclip
git tag -a dingtalk-rag-tool-ga -m "B1 GA: rag.searchRefundComments registered + UpstreamError plumbing"

# dingtalk bot repo
cd /Users/melodylu/PycharmProjects/paperclip-dingtalk-bot
git tag -a dingtalk-rag-tool-ga -m "B1 GA: err_class plumbing + RAG vs DWS dispatch prompt"
```

Do NOT push the tag without explicit user confirmation.

- [ ] **Step 8: Final summary**

Both repos: `git log --oneline -5` to confirm the commits landed.

---

## Self-Review

**Spec coverage check** (against `2026-05-18-rag-as-dingtalk-tool-design.md`):

| Spec section | Covered by |
|---|---|
| §3.1 New files (rag/client.ts + .test.ts + searchRefundComments.ts + .test.ts) | Tasks 3, 4 |
| §3.2 Modified registry.ts | Task 5 |
| §3.2 Modified llm_dispatcher.py (line 199 err_class) | Task 2 |
| §3.2 Modified pcl_runner.py | Task 1 |
| §3.3 err_class plumbing rationale → 4-line fix | Tasks 1, 2 |
| §4 Tool descriptor (id, source, cliSubcommand, description, schemas, handler) | Task 4 |
| §4.1 HTTP client (default base, env override, timeout, abort, error classes) | Task 3 |
| §4.2 Registration | Task 5 |
| §5 Error matrix (all 7 rows) | Tasks 3 (client errors), 4 (handler wrapping + zod) |
| §6.1 Append bullet to chain-tools list | Task 7 Step 2 |
| §6.2 Insert RAG vs DWS comparison section | Task 7 Step 3 |
| §6.3 Tool catalog auto-pickup (no Python change beyond §3.2) | Task 8 Step 2 |
| §7.1 TS unit tests | Tasks 3, 4 |
| §7.2 Python unit tests | Tasks 1, 2 |
| §7.3 Manual smoke tests M1-M3 | Task 8 |
| §8 Acceptance criteria — items 1-7 | Tasks 4 (vitest), 6 (CLI smoke), 5 (registry list), 8 (bot restart, M1/M2/M3, RAG log, tag) |

All covered.

**Placeholder scan:** None — every step has runnable commands or full code.

**Type/name consistency check:**
- `RagSearchInput` / `RagSearchOk` / `RagUnavailable` consistent across Tasks 3, 4.
- `RagSearchRefundCommentsInput` / `Output` consistent in Task 4.
- Python `PclToolsError.err_class` consistent across Tasks 1, 2.
- error message strings ("rag service unavailable", "UpstreamError") consistent across Tasks 3, 4, 7.
- Tool id `rag.searchRefundComments` and cli subcommand `search-refund-comments` used identically across Tasks 4, 5, 6, 7, 8.
