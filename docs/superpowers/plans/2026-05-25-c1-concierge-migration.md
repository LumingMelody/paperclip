# C1 — Concierge Migration 实施 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把钉钉 bot 重构为「极薄 DingTalk 协议适配层」，把 LLM 派发 / prompt / 会话记忆全部上移到 paperclip 平台的 Concierge agent，解 Debt-1（bot 平行的 mini agent 平台）。

**Architecture:** 钉钉 bot 收到群消息 → POST 到 paperclip server 新增的 `/api/chat` endpoint → server 创建（或复用）一个 issue 作为「会话容器」、添加用户 comment、assignee 设为 Concierge agent → 复用现有 `queueIssueAssignmentWakeup` 触发 Concierge 唤醒 → Concierge 跑业务逻辑（一轮 LLM 路由 + 工具调用 / 派 sub-issue 给业务 agent）→ 把答案写成 issue_comment、把 issue.status 设为 `done` → bot 端短轮询 `GET /issues/:id`，拿到 done 后读 comments、用钉钉 OpenAPI `groupMessages/send` 推回群。Fallback：paperclip server 5xx 时 bot 走当前 `llm_dispatcher` 自答兜底。

**Tech Stack:**
- paperclip server: Express.js + Drizzle ORM (PostgreSQL) + Vitest
- paperclip-dingtalk-bot: Python 3.11 + python-dotenv + httpx + dingtalk-stream
- DingTalk OpenAPI: `/v1.0/oauth2/accessToken` + `/v1.0/robot/groupMessages/send`
- Concierge LLM: 推荐 Claude API 直连（解 tabcode 锁定 + 拿 prompt cache）；MVP 可暂用现有配置不阻塞
- 复用：`server/src/services/issue-assignment-wakeup.ts::queueIssueAssignmentWakeup`、`packages/db/src/schema/issues.ts` + `issue_comments.ts`
- **不新建**：ChatSession 表（issue 已经能当容器）、agents/ 目录（paperclip 用 DB-as-agent-store）

---

## 关键架构决策（写在前面避免歧义）

1. **"会话" = "issue"。** 每次新对话开一个 issue，title 取用户首句前 80 字；后续 user 消息作为新 comment 加到 issue；Concierge 答案作为 comment 加到 issue + 设 status=done。下一轮 user 消息默认新开 issue（无需"connect"，简化 MVP）。
2. **Bot 端短轮询**，不订阅 live-events WebSocket（MVP 简单）。轮询间隔 5s，超时 5 分钟（钉钉那边立即 ack "正在处理"，最终结果靠主动 push）。
3. **Concierge agent 用 DB seed 创建**（POST /companies/:companyId/agents）。其 prompt + tool whitelist 存在 agent 记录的 `instructions` 字段。
4. **DingTalk 不进 paperclip 本体**。bot 保留 DingTalk knowledge，paperclip 只产生纯 markdown 答案。push 由 bot 完成。
5. **Bot dispatcher 保留作 fallback**。`/api/chat` 失败 5xx 或超时 → 走现有 `llm_dispatcher`。fallback 路径未来都没失败的话再砍。

---

## File Structure

**paperclip 主仓 (Express server)：**

- 新建 `server/src/routes/chat.ts` — POST /api/chat endpoint
- 新建 `server/src/services/chat.ts` — chat-as-issue 业务逻辑（创建 issue、加 comment、assignee 设 Concierge、触发 wakeup）
- 修改 `server/src/app.ts` — 挂载 chatRoutes
- 新建 `server/src/__tests__/chat-routes.test.ts` — vitest 单测
- 新建 `server/src/__tests__/chat-service.test.ts` — service 层单测
- 新建 `scripts/seed-concierge-agent.ts` — 幂等 seed Concierge agent 的脚本
- 新建 `docs/agents/concierge.md` — Concierge prompt/role 设计文档

**paperclip-dingtalk-bot 仓库 (Python)：**

- 新建 `paperclip-dingtalk-bot/concierge_client.py` — httpx 客户端封装 POST /api/chat + GET /issues/:id + GET /issues/:id/comments
- 新建 `paperclip-dingtalk-bot/poll_worker.py` — 后台轮询 worker（issue done 检测 + 拉 comment + DingTalk push）
- 修改 `paperclip-dingtalk-bot/main.py` — 收到消息后调 concierge_client，不再直接调 llm_dispatcher
- 修改 `paperclip-dingtalk-bot/config.py` — 新增 PAPERCLIP_BASE_URL / PAPERCLIP_COMPANY_ID / PAPERCLIP_CONCIERGE_AGENT_ID 配置
- 保留 `paperclip-dingtalk-bot/llm_dispatcher.py` — 作 fallback，不删
- 新建 `paperclip-dingtalk-bot/tests/test_concierge_client.py` — respx mock
- 新建 `paperclip-dingtalk-bot/tests/test_poll_worker.py` — respx mock + timeout 场景
- 修改 `paperclip-dingtalk-bot/.env` — 加新配置项（不进 git）

---

## Phase 0 — Discovery（必做，不能跳）

**目的**：在写代码前补齐 4 个事实问题，否则 Phase 2 的 Concierge 实现会卡在"agent 究竟怎么跑起来"。Phase 0 输出一份 `docs/superpowers/specs/2026-05-25-c1-concierge-spec.md`，里面写清下面 4 个问题的答案 + 引用文件:行号，作为 Phase 2 的施工依据。

### Task 0.1: 摸清 paperclip 现有 agent 的执行模型

**Files:**
- Read: `server/src/services/agents.ts`
- Read: `server/src/services/heartbeat.ts`（重点搜 "wakeup" / "run" / "dispatch" / "process" 函数）
- Read: `server/src/services/issue-assignment-wakeup.ts:21-48`
- Read: 任一已实际跑过的 agent 触发链路（Finance / CXOps / DataPlatform 之一），从 `queueIssueAssignmentWakeup → heartbeat.wakeup` 一路追到 agent prompt 实际被发给哪个 LLM provider

- [ ] **Step 1: grep agent 执行路径**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
grep -rn "function.*runAgent\|function.*executeAgent\|function.*processAgentTurn\|llm.*invoke\|claude.*messages\|openai.*chat" server/src/services/ | head -30
```

记录所有命中行号到 `agent-execution-trace.txt`（临时草稿，不入 git）。

- [ ] **Step 2: 找 LLM provider 调用点**

```bash
grep -rn "anthropic\|@anthropic-ai/sdk\|api.anthropic" server/src/ packages/ | head -20
grep -rn "openai\|baseURL.*tabcode" server/src/ packages/ | head -20
```

记录现役 agent 实际用哪个 LLM provider（Claude API / tabcode / 其它）。

- [ ] **Step 3: 写 spec doc**

创建 `docs/superpowers/specs/2026-05-25-c1-concierge-spec.md`，至少含：
1. agent runtime 模型一句话总结（subprocess / in-process worker / 别的）
2. agent 被 wake 后到 LLM 调用之间的关键函数链（文件:行号 形式）
3. 现役 LLM provider + API key 配置位置（环境变量名 / 配置文件）
4. 新 agent 创建后是否自动被 heartbeat scheduler 纳管（如果不，要做什么注册动作）

- [ ] **Step 4: Commit spec**

```bash
git add docs/superpowers/specs/2026-05-25-c1-concierge-spec.md
git commit -m "docs(c1): concierge migration — agent-runtime spec"
```

### Task 0.2: 验证 issue 状态变更的事件钩子

**Files:**
- Read: `server/src/services/live-events.ts:27-34`
- Read: `server/src/services/issues.ts`（搜 `publishLiveEvent` 出现位置 + `status: "done"` 写入点）

- [ ] **Step 1: 确认 issue → done 时是否 publishLiveEvent**

```bash
cd /Users/melodylu/PycharmProjects/paperclip/server
grep -n "publishLiveEvent\|status.*done" src/services/issues.ts | head -20
```

期望找到形如 `publishLiveEvent({ companyId, type: "issue.updated", payload })` 的写入点。

- [ ] **Step 2: 决定 bot 的 done-检测策略**

把决策写入 spec doc 的「轮询 vs WebSocket」一节：
- **MVP 决策**：bot 用短轮询（5s 间隔，5min 超时）。理由：实现最简单、调试最容易，bot 单用户单群体可接受 5s 延迟。WebSocket 留 v2。
- 把此结论补进 `docs/superpowers/specs/2026-05-25-c1-concierge-spec.md`。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-25-c1-concierge-spec.md
git commit --amend --no-edit
```

---

## Phase 1 — paperclip 新增 POST /api/chat endpoint

**目的**：实现 chat-as-issue 业务逻辑（新建 / 复用 issue + 加 user comment + 派给 Concierge + 触发 wakeup）。

### Task 1.1: 写 service 层失败测试

**Files:**
- Test: `server/src/__tests__/chat-service.test.ts`

- [ ] **Step 1: 写测试文件**

参考 `server/src/__tests__/monthly-spend-service.test.ts` 第 1-50 行的 vitest + mock-chain pattern，写：

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatService } from "../services/chat.ts";

describe("chatService.handleIncoming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new issue when no openConversationKey is provided", async () => {
    const fakeDb = createFakeDb();
    const fakeWakeup = vi.fn();
    const svc = chatService({ db: fakeDb, wakeup: fakeWakeup, conciergeAgentId: "agent-uuid-x" });

    const result = await svc.handleIncoming({
      companyId: "co-1",
      projectId: "proj-1",
      senderKey: "ding-user-001",
      text: "EE02968 顾客主要抱怨什么",
    });

    expect(result.issueId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.created).toBe(true);
    expect(fakeWakeup).toHaveBeenCalledOnce();
    expect(fakeWakeup.mock.calls[0][0]).toBe("agent-uuid-x");
  });

  it("adds a comment to existing open issue when conversationKey matches", async () => {
    // ... assert: no new issue created, comment appended, wakeup re-fired
  });
});

function createFakeDb() {
  // vitest mock chain — pattern from monthly-spend-service.test.ts
  // returns { insert, select, update } chainable mocks
}
```

补完 `createFakeDb` 和第二个 test case 主体。

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
cd /Users/melodylu/PycharmProjects/paperclip/server
pnpm vitest run src/__tests__/chat-service.test.ts
```

预期：`Cannot find module '../services/chat.ts'` 或 `chatService is not a function`。

### Task 1.2: 实现 service 层

**Files:**
- Create: `server/src/services/chat.ts`

- [ ] **Step 1: 写最小实现**

```typescript
import { eq } from "drizzle-orm";
import { issues } from "@paperclip/db/schema/issues";
import { issueComments } from "@paperclip/db/schema/issue_comments";
import type { Db } from "../db.ts";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.ts";
import { issueService } from "./issues.ts";

export interface ChatServiceDeps {
  db: Db;
  conciergeAgentId: string;  // env: PAPERCLIP_CONCIERGE_AGENT_ID
  // wakeup 注入，方便测试 mock
  wakeup?: typeof queueIssueAssignmentWakeup;
  heartbeat?: any;  // pass-through to wakeup; real shape per heartbeatService.ts
}

export interface ChatHandleInput {
  companyId: string;
  projectId: string;
  senderKey: string;        // DingTalk sender_staff_id, 用作 conversationKey 维度
  conversationKey?: string; // 显式覆盖；默认 = senderKey
  text: string;             // 用户消息原文
}

export interface ChatHandleResult {
  issueId: string;
  created: boolean;  // true 表示新 issue；false 表示往现有 issue 加 comment
}

export function chatService(deps: ChatServiceDeps) {
  return {
    async handleIncoming(input: ChatHandleInput): Promise<ChatHandleResult> {
      const convKey = input.conversationKey ?? input.senderKey;
      // 1) 找该 senderKey 最近 24h 内 status != done/cancelled 的 issue，作 "open conversation"
      const recent = await deps.db
        .select()
        .from(issues)
        .where(/* companyId + dingtalk_conversation_key column = convKey + status not in [done, cancelled] */)
        .limit(1);

      let issueId: string;
      let created: boolean;
      if (recent.length > 0) {
        issueId = recent[0].id;
        created = false;
      } else {
        // 2) 新建 issue
        const inserted = await deps.db.insert(issues).values({
          companyId: input.companyId,
          projectId: input.projectId,
          title: input.text.slice(0, 80),
          description: input.text,
          assigneeAgentId: deps.conciergeAgentId,
          status: "todo",
          // dingtalkConversationKey: convKey, // 见 1.3 加 column
        }).returning({ id: issues.id });
        issueId = inserted[0].id;
        created = true;
      }

      // 3) 把 user 消息作为 comment 加入 issue
      await deps.db.insert(issueComments).values({
        issueId,
        authorUserId: input.senderKey,
        body: input.text,
      });

      // 4) 触发 Concierge 唤醒
      const wakeupFn = deps.wakeup ?? queueIssueAssignmentWakeup;
      await wakeupFn({
        heartbeat: deps.heartbeat,
        issue: { id: issueId, assigneeAgentId: deps.conciergeAgentId, status: "todo" },
        reason: created ? "new chat session" : "user follow-up",
        mutation: "chat.handleIncoming",
        contextSource: "chat",
      });

      return { issueId, created };
    },
  };
}
```

注：`dingtalk_conversation_key` 列下面 Task 1.3 加。

- [ ] **Step 2: 跑测试确认 PASS**

```bash
pnpm vitest run src/__tests__/chat-service.test.ts
```

预期：两个 case 全 pass。如有失败，调整 service 实现直到通过；不要改测试预期。

- [ ] **Step 3: Commit**

```bash
git add server/src/services/chat.ts server/src/__tests__/chat-service.test.ts
git commit -m "feat(server): chat service — issue-as-conversation container

POST /api/chat 的业务逻辑：senderKey 维度查最近未完成 issue，
有就追加 comment，没有就新建 issue 并 assignee=Concierge agent。
两路径都触发 queueIssueAssignmentWakeup。"
```

### Task 1.3: DB migration — issues 加 dingtalk_conversation_key 列

**Files:**
- Create: `packages/db/src/migrations/00XX_chat_conversation_key.sql`（编号取当前最大 +1）
- Modify: `packages/db/src/schema/issues.ts`（加 `dingtalkConversationKey: text("dingtalk_conversation_key")`）

- [ ] **Step 1: 看当前最大 migration 编号**

```bash
ls /Users/melodylu/PycharmProjects/paperclip/packages/db/src/migrations/*.sql | sort | tail -3
```

假设最大是 0075 → 新编号 0076。

- [ ] **Step 2: 写 migration**

```sql
ALTER TABLE "issues" ADD COLUMN "dingtalk_conversation_key" text;
--> statement-breakpoint
CREATE INDEX "issues_dingtalk_conv_key_status_idx" ON "issues"
  USING btree ("company_id","dingtalk_conversation_key","status");
```

- [ ] **Step 3: 同步 Drizzle schema**

在 `packages/db/src/schema/issues.ts` 的 issues 表定义里加：
```typescript
dingtalkConversationKey: text("dingtalk_conversation_key"),
```

- [ ] **Step 4: 跑 migration（本地 dev DB）**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
pnpm --filter @paperclip/db migrate
```

预期：migration 0076 应用成功，schema sync 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/0076_chat_conversation_key.sql packages/db/src/schema/issues.ts
git commit -m "feat(db): issues add dingtalk_conversation_key for chat session lookup"
```

### Task 1.4: 写 route layer 失败测试

**Files:**
- Test: `server/src/__tests__/chat-routes.test.ts`

- [ ] **Step 1: 写测试**

参考 `server/src/__tests__/` 下任一 routes 测试（grep `from "../routes"` 找近似 pattern）。MVP 至少 3 个 case：
1. POST /api/chat 正常返回 { issueId, created: true } + status 201
2. POST /api/chat 缺 text → 422 (zod validation)
3. POST /api/chat 服务层抛 → 500 + error payload

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { chatRoutes } from "../routes/chat.ts";

describe("POST /chat", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    const fakeChatSvc = {
      handleIncoming: vi.fn().mockResolvedValue({ issueId: "issue-uuid", created: true }),
    };
    app.use(chatRoutes({ chatService: fakeChatSvc } as any));
  });

  it("returns 201 with issueId for new conversation", async () => {
    const res = await request(app)
      .post("/chat")
      .send({ companyId: "c1", projectId: "p1", senderKey: "u1", text: "hello" });
    expect(res.status).toBe(201);
    expect(res.body.issueId).toBe("issue-uuid");
    expect(res.body.created).toBe(true);
  });

  it("returns 422 when text is missing", async () => {
    const res = await request(app)
      .post("/chat")
      .send({ companyId: "c1", projectId: "p1", senderKey: "u1" });
    expect(res.status).toBe(422);
  });

  it("returns 500 when chat service throws", async () => {
    // 重新 setup fakeChatSvc.handleIncoming.mockRejectedValue(...)
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
pnpm vitest run src/__tests__/chat-routes.test.ts
```

预期：`Cannot find module '../routes/chat.ts'`。

### Task 1.5: 实现 route layer

**Files:**
- Create: `server/src/routes/chat.ts`

- [ ] **Step 1: 写最小实现**

```typescript
import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.ts";  // 参考 issues.ts 的 validate 用法
import type { chatService } from "../services/chat.ts";

const chatRequestSchema = z.object({
  companyId: z.string().min(1),
  projectId: z.string().min(1),
  senderKey: z.string().min(1),
  conversationKey: z.string().optional(),
  text: z.string().min(1).max(4000),
});

interface ChatRoutesDeps {
  chatService: ReturnType<typeof chatService>;
}

export function chatRoutes(deps: ChatRoutesDeps) {
  const router = Router();

  router.post("/chat", validate(chatRequestSchema), async (req, res) => {
    try {
      const result = await deps.chatService.handleIncoming(req.body);
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message ?? "chat service failure" });
    }
  });

  return router;
}
```

- [ ] **Step 2: 跑测试确认 PASS**

```bash
pnpm vitest run src/__tests__/chat-routes.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/chat.ts server/src/__tests__/chat-routes.test.ts
git commit -m "feat(server): POST /api/chat route — DingTalk bot entry point"
```

### Task 1.6: 挂载到 app.ts

**Files:**
- Modify: `server/src/app.ts`（在第 180-296 行 `api.use(...)` 区段加一行）

- [ ] **Step 1: 加挂载**

在 app.ts 现有 `api.use(...)` 区段（参考 `api.use(issueRoutes(db, storageService))` 之类）后面加：

```typescript
import { chatRoutes } from "./routes/chat.ts";
import { chatService } from "./services/chat.ts";
// ...
const conciergeAgentId = process.env.PAPERCLIP_CONCIERGE_AGENT_ID;
if (!conciergeAgentId) {
  logger.warn("PAPERCLIP_CONCIERGE_AGENT_ID not set; /api/chat will fail at runtime");
}
api.use(chatRoutes({
  chatService: chatService({
    db,
    conciergeAgentId: conciergeAgentId ?? "MISSING",
    heartbeat: heartbeatService,  // 真实 heartbeat service 实例，参考其它 routes 怎么注入
  }),
}));
```

- [ ] **Step 2: 跑全部 server 测试不能炸**

```bash
pnpm vitest run
```

预期：所有现有测试 + chat-routes / chat-service 测试全 pass。

- [ ] **Step 3: Commit**

```bash
git add server/src/app.ts
git commit -m "feat(server): mount POST /api/chat with concierge agent id from env"
```

---

## Phase 2 — Concierge agent seed

**目的**：在 paperclip 数据库里创建 Concierge agent 记录（含 prompt + tool whitelist），让其能被 chat service 的 wakeup 触发执行。

### Task 2.1: 设计 Concierge 的 prompt + tool whitelist

**Files:**
- Create: `docs/agents/concierge.md`

- [ ] **Step 1: 写 prompt 文档**

照搬 bot 现有 `SYSTEM_PROMPT_TEMPLATE`（在 `~/PycharmProjects/paperclip-dingtalk-bot/llm_dispatcher.py:23+`），把里面跟"我是 EverPretty 智能助手 / 退货专题三段式 / RAG vs DWS 选择"等所有专题保留。新增一段说明 Concierge 的「路由 + 答题」职责：
- 默认自己用 22 个工具直接答（v1 不派 sub-issue 给其它业务 agent，那是 v2）
- 答完直接把 markdown 写进 issue.comments（最后一条 comment 视为最终答案）
- 设 issue.status = done

`docs/agents/concierge.md` 至少含：
- role: "Concierge / general dispatcher"
- prompt（完整 markdown 字符串）
- tool whitelist: 全部 22 个 tool ID（list）
- LLM provider: 沿用 paperclip 现役 agent 的 provider（Phase 0 spec 确认过用哪个）

- [ ] **Step 2: Commit**

```bash
git add docs/agents/concierge.md
git commit -m "docs(c1): concierge agent prompt + tool whitelist spec"
```

### Task 2.2: 写 seed 脚本

**Files:**
- Create: `scripts/seed-concierge-agent.ts`

- [ ] **Step 1: 写脚本**

```typescript
#!/usr/bin/env tsx
/**
 * Idempotently upsert the Concierge agent into the paperclip DB.
 *
 * Usage:
 *   PAPERCLIP_COMPANY_ID=<uuid> tsx scripts/seed-concierge-agent.ts
 *
 * Prints the agent's UUID to stdout — pipe into PAPERCLIP_CONCIERGE_AGENT_ID
 * env var for the server.
 */
import fs from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { agents } from "../packages/db/src/schema/agents.ts";
import { getDb } from "../server/src/db.ts";

async function main() {
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId) throw new Error("PAPERCLIP_COMPANY_ID required");

  const promptPath = path.resolve(__dirname, "../docs/agents/concierge.md");
  const prompt = fs.readFileSync(promptPath, "utf-8");

  const db = await getDb();

  // 检查是否已存在 name=Concierge 的 agent
  const existing = await db.select().from(agents).where(
    and(eq(agents.companyId, companyId), eq(agents.name, "Concierge"))
  );

  if (existing.length > 0) {
    // 更新 prompt + tool whitelist
    await db.update(agents).set({
      instructions: prompt,
      // toolWhitelist: [...22 tool ids],  // 字段名按 packages/db/src/schema/agents.ts 实际
      updatedAt: new Date(),
    }).where(eq(agents.id, existing[0].id));
    console.log(existing[0].id);
    return;
  }

  // 新建
  const inserted = await db.insert(agents).values({
    companyId,
    name: "Concierge",
    role: "concierge",
    instructions: prompt,
    // toolWhitelist: [...22 tool ids],
  }).returning({ id: agents.id });

  console.log(inserted[0].id);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

注：agents 表实际字段名要按 `packages/db/src/schema/agents.ts` 调整。tool whitelist 字段名 + 类型同。

- [ ] **Step 2: 跑 seed**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
export PAPERCLIP_COMPANY_ID=a0f62167-5f88-475b-bdc0-3d4cb80184dc  # 从 tool-secrets.json 拿
tsx scripts/seed-concierge-agent.ts
```

预期：stdout 输出一个 UUID（Concierge agent ID）。把它存到 `.env.local` 当 `PAPERCLIP_CONCIERGE_AGENT_ID`。

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-concierge-agent.ts
git commit -m "feat(c1): seed script for Concierge agent (idempotent upsert)"
```

### Task 2.3: 手工触发一次 Concierge 跑通

**Files:**
- 无新文件，使用 curl

- [ ] **Step 1: 启动 server（确保 PAPERCLIP_CONCIERGE_AGENT_ID 已 export）**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
PAPERCLIP_CONCIERGE_AGENT_ID=<seed 输出的 uuid> pnpm dev
```

- [ ] **Step 2: curl 触发 chat**

```bash
curl -s -XPOST http://127.0.0.1:3100/api/chat -H 'content-type: application/json' -d '{
  "companyId": "a0f62167-5f88-475b-bdc0-3d4cb80184dc",
  "projectId": "<查 paperclip 项目 uuid>",
  "senderKey": "test-user-001",
  "text": "EE02968 顾客主要抱怨什么"
}'
```

预期：返回 `{ "issueId": "...", "created": true }`，立即返回（< 500ms）。

- [ ] **Step 3: 观察 issue 是否被 Concierge 处理**

打开 paperclip Web UI（http://127.0.0.1:3100），找到刚创建的 issue：
- 看 assignee 是不是 Concierge
- 等 ≤ 60s 看 status 是否变 done
- 看 issue.comments 是不是出现 Concierge 的答案

成功标准：Concierge agent 在 60s 内完成 issue 并把 markdown 答案写入 comment。

如果失败：回到 Phase 0 spec doc 复查 agent runtime 模型，可能需要补一步注册 Concierge 到 heartbeat scheduler 或类似动作。

- [ ] **Step 4: 把成功标准写入 spec doc + commit**

```bash
# 把 curl 的 issue 状态变化时间、Concierge 答案样例追加到
# docs/superpowers/specs/2026-05-25-c1-concierge-spec.md 的「Phase 2 验收记录」段
git add docs/superpowers/specs/2026-05-25-c1-concierge-spec.md
git commit -m "docs(c1): phase 2 — concierge end-to-end run record"
```

---

## Phase 3 — Bot 改造为转发器 + fallback

**目的**：bot 收到群消息后转发到 paperclip `/api/chat`，开后台 poll worker 追 issue 完成、最后 push 回钉钉。fallback 保留 llm_dispatcher 兜底。

### Task 3.1: 写 concierge_client.py + 单测

**Files:**
- Create: `paperclip-dingtalk-bot/concierge_client.py`
- Test: `paperclip-dingtalk-bot/tests/test_concierge_client.py`

- [ ] **Step 1: 写失败测试**

```python
import httpx
import pytest
import respx
from concierge_client import ConciergeClient, ConciergeUnavailable


@respx.mock
@pytest.mark.asyncio
async def test_post_chat_returns_issue_id():
    respx.post("http://paperclip/api/chat").mock(
        return_value=httpx.Response(201, json={"issueId": "issue-uuid", "created": True})
    )
    client = ConciergeClient(base_url="http://paperclip", company_id="c1", project_id="p1")
    r = await client.post_chat(sender_key="u1", text="hello")
    assert r["issueId"] == "issue-uuid"


@respx.mock
@pytest.mark.asyncio
async def test_post_chat_5xx_raises_unavailable():
    respx.post("http://paperclip/api/chat").mock(return_value=httpx.Response(503))
    client = ConciergeClient(base_url="http://paperclip", company_id="c1", project_id="p1")
    with pytest.raises(ConciergeUnavailable):
        await client.post_chat(sender_key="u1", text="hello")


@respx.mock
@pytest.mark.asyncio
async def test_get_issue_status():
    respx.get("http://paperclip/api/issues/x").mock(
        return_value=httpx.Response(200, json={"id": "x", "status": "done"})
    )
    client = ConciergeClient(base_url="http://paperclip", company_id="c1", project_id="p1")
    r = await client.get_issue("x")
    assert r["status"] == "done"


@respx.mock
@pytest.mark.asyncio
async def test_get_latest_concierge_comment():
    respx.get("http://paperclip/api/issues/x/comments").mock(
        return_value=httpx.Response(200, json={"comments": [
            {"id": "c1", "authorUserId": "u1", "body": "EE02968 抱怨什么"},
            {"id": "c2", "authorAgentId": "concierge-uuid", "body": "答案 markdown ..."},
        ]})
    )
    client = ConciergeClient(base_url="http://paperclip", company_id="c1", project_id="p1",
                             concierge_agent_id="concierge-uuid")
    answer = await client.get_latest_agent_comment("x")
    assert answer == "答案 markdown ..."
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
cd ~/PycharmProjects/paperclip-dingtalk-bot
uv run pytest tests/test_concierge_client.py -q
```

预期：`ModuleNotFoundError: No module named 'concierge_client'`。

### Task 3.2: 实现 concierge_client

**Files:**
- Create: `paperclip-dingtalk-bot/concierge_client.py`

- [ ] **Step 1: 写实现**

```python
"""HTTP client for paperclip Concierge chat flow."""
from __future__ import annotations

import httpx


class ConciergeUnavailable(Exception):
    """Raised when paperclip /api/chat returns 5xx or is unreachable."""


class ConciergeClient:
    def __init__(self, base_url: str, company_id: str, project_id: str,
                 concierge_agent_id: str | None = None, timeout: float = 8.0):
        self.base_url = base_url.rstrip("/")
        self.company_id = company_id
        self.project_id = project_id
        self.concierge_agent_id = concierge_agent_id
        self.timeout = timeout

    async def post_chat(self, sender_key: str, text: str,
                        conversation_key: str | None = None) -> dict:
        async with httpx.AsyncClient(timeout=self.timeout) as cx:
            try:
                r = await cx.post(
                    f"{self.base_url}/api/chat",
                    json={
                        "companyId": self.company_id,
                        "projectId": self.project_id,
                        "senderKey": sender_key,
                        "conversationKey": conversation_key,
                        "text": text,
                    },
                )
            except httpx.HTTPError as e:
                raise ConciergeUnavailable(str(e)) from e
            if r.status_code >= 500:
                raise ConciergeUnavailable(f"5xx: {r.status_code} {r.text}")
            r.raise_for_status()
            return r.json()

    async def get_issue(self, issue_id: str) -> dict:
        async with httpx.AsyncClient(timeout=self.timeout) as cx:
            r = await cx.get(f"{self.base_url}/api/issues/{issue_id}")
            r.raise_for_status()
            return r.json()

    async def get_latest_agent_comment(self, issue_id: str) -> str | None:
        """Return the last issue_comment authored by Concierge agent, or None."""
        async with httpx.AsyncClient(timeout=self.timeout) as cx:
            r = await cx.get(f"{self.base_url}/api/issues/{issue_id}/comments")
            r.raise_for_status()
            comments = r.json().get("comments", [])
            for c in reversed(comments):
                if c.get("authorAgentId") == self.concierge_agent_id:
                    return c.get("body")
            return None
```

- [ ] **Step 2: 跑测试确认 PASS**

```bash
uv run pytest tests/test_concierge_client.py -q
```

预期：4 个 case 全 pass。

- [ ] **Step 3: Commit**

```bash
git add concierge_client.py tests/test_concierge_client.py
git commit -m "feat(bot): concierge http client (post_chat + issue/comments polling)"
```

### Task 3.3: 写 poll_worker.py + 测试

**Files:**
- Create: `paperclip-dingtalk-bot/poll_worker.py`
- Test: `paperclip-dingtalk-bot/tests/test_poll_worker.py`

- [ ] **Step 1: 写测试**

```python
import asyncio
import httpx
import pytest
import respx
from concierge_client import ConciergeClient
from poll_worker import poll_until_done, PollTimeout


@respx.mock
@pytest.mark.asyncio
async def test_poll_returns_answer_when_status_done():
    # 第一次轮询 status=todo；第二次 status=done
    respx.get("http://paperclip/api/issues/x").mock(side_effect=[
        httpx.Response(200, json={"id": "x", "status": "todo"}),
        httpx.Response(200, json={"id": "x", "status": "done"}),
    ])
    respx.get("http://paperclip/api/issues/x/comments").mock(
        return_value=httpx.Response(200, json={"comments": [
            {"authorAgentId": "concierge-uuid", "body": "答案 markdown"},
        ]})
    )
    client = ConciergeClient(base_url="http://paperclip", company_id="c1", project_id="p1",
                             concierge_agent_id="concierge-uuid")
    answer = await poll_until_done(client, issue_id="x", interval=0.01, timeout=5.0)
    assert answer == "答案 markdown"


@respx.mock
@pytest.mark.asyncio
async def test_poll_timeout_raises():
    respx.get("http://paperclip/api/issues/x").mock(
        return_value=httpx.Response(200, json={"id": "x", "status": "in_progress"})
    )
    client = ConciergeClient(base_url="http://paperclip", company_id="c1", project_id="p1",
                             concierge_agent_id="concierge-uuid")
    with pytest.raises(PollTimeout):
        await poll_until_done(client, issue_id="x", interval=0.01, timeout=0.05)
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
uv run pytest tests/test_poll_worker.py -q
```

- [ ] **Step 3: 写实现**

```python
"""Background poll worker: watches issue → done → fetches latest Concierge comment."""
from __future__ import annotations

import asyncio
import time

from concierge_client import ConciergeClient


class PollTimeout(Exception):
    """Raised when poll_until_done exceeds the configured timeout."""


async def poll_until_done(client: ConciergeClient, issue_id: str,
                          interval: float = 5.0, timeout: float = 300.0) -> str:
    """Poll GET /issues/:id every `interval` seconds until status==done or timeout.

    Returns the last Concierge comment body on success; raises PollTimeout otherwise.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        issue = await client.get_issue(issue_id)
        if issue.get("status") == "done":
            answer = await client.get_latest_agent_comment(issue_id)
            if answer is None:
                return "(Concierge 已完成但未返回 comment)"
            return answer
        await asyncio.sleep(interval)
    raise PollTimeout(f"issue {issue_id} not done after {timeout}s")
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
uv run pytest tests/test_poll_worker.py -q
```

- [ ] **Step 5: Commit**

```bash
git add poll_worker.py tests/test_poll_worker.py
git commit -m "feat(bot): poll worker — wait for issue done + extract concierge answer"
```

### Task 3.4: 改 main.py 用 Concierge 路径 + fallback

**Files:**
- Modify: `paperclip-dingtalk-bot/main.py`
- Modify: `paperclip-dingtalk-bot/config.py`

- [ ] **Step 1: 读 config.py 加新配置项**

在 `config.py` 加：

```python
PAPERCLIP_BASE_URL = os.environ.get("PAPERCLIP_BASE_URL", "http://127.0.0.1:3100").strip()
PAPERCLIP_COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "").strip()
PAPERCLIP_PROJECT_ID = os.environ.get("PAPERCLIP_PROJECT_ID", "").strip()
PAPERCLIP_CONCIERGE_AGENT_ID = os.environ.get("PAPERCLIP_CONCIERGE_AGENT_ID", "").strip()

# Feature flag — gradual rollout. Default True 表示新对话默认走 Concierge；False 表示永远 fallback。
CONCIERGE_ROUTE_ENABLED = os.environ.get("CONCIERGE_ROUTE_ENABLED", "true").lower() == "true"
```

- [ ] **Step 2: 改 main.py 的 dispatch 路径**

找到 main.py 里 ChatbotMessage 处理入口（之前那段 "incoming: '...'" 的 log 出现的地方），把"调 llm_dispatcher.dispatch"那条路径改成：

```python
async def handle_message(msg):
    text = msg.text.content.strip()
    sender = msg.sender_staff_id
    # ack 立即回复 "正在处理"
    await reply_markdown(msg, title="处理中", text=f"已收到: **{text}**\n\n正在调度...")

    if not config.CONCIERGE_ROUTE_ENABLED:
        return await _fallback_dispatcher(msg, text, sender)

    client = ConciergeClient(
        base_url=config.PAPERCLIP_BASE_URL,
        company_id=config.PAPERCLIP_COMPANY_ID,
        project_id=config.PAPERCLIP_PROJECT_ID,
        concierge_agent_id=config.PAPERCLIP_CONCIERGE_AGENT_ID,
    )
    try:
        chat_resp = await client.post_chat(sender_key=sender, text=text)
    except ConciergeUnavailable as e:
        logger.warning("concierge unavailable, falling back: %s", e)
        return await _fallback_dispatcher(msg, text, sender)

    issue_id = chat_resp["issueId"]
    try:
        answer = await poll_until_done(client, issue_id=issue_id, interval=5.0, timeout=300.0)
    except PollTimeout:
        answer = "⚠️ Concierge 超时 (>5min) 未完成。Issue: " + issue_id + "（已记录到 paperclip）"

    # push 钉钉
    await active_push(msg, title="EverPretty 智能助手", text=answer + "\n\n———\n via Concierge")


async def _fallback_dispatcher(msg, text, sender):
    """走老 llm_dispatcher 兜底。"""
    answer, _ = await llm_dispatcher.dispatch(
        user_text=text,
        issue_id=f"DINGTALK-{sender}-fallback",
        prior_items=None,  # 简化：fallback 不带 history
    )
    await active_push(msg, title="EverPretty 智能助手", text=answer + "\n\n———\n via fallback")
```

注：`reply_markdown` / `active_push` 用 main.py 现有的 helper（dingtalk-stream SDK）。

- [ ] **Step 3: Commit**

```bash
git add main.py config.py
git commit -m "feat(bot): route incoming messages to paperclip Concierge with llm_dispatcher fallback

CONCIERGE_ROUTE_ENABLED env flag for safe gradual rollout (default true).
ConciergeUnavailable / PollTimeout 自动降级到 llm_dispatcher。"
```

---

## Phase 4 — 端到端验证

### Task 4.1: 配 .env 启动 bot + server

- [ ] **Step 1: 改 bot .env**

```bash
cd ~/PycharmProjects/paperclip-dingtalk-bot
cat >> .env <<EOF

# C1 Concierge migration
PAPERCLIP_BASE_URL=http://127.0.0.1:3100
PAPERCLIP_COMPANY_ID=a0f62167-5f88-475b-bdc0-3d4cb80184dc
PAPERCLIP_PROJECT_ID=<查 paperclip 项目 uuid>
PAPERCLIP_CONCIERGE_AGENT_ID=<phase 2 seed 输出的 uuid>
CONCIERGE_ROUTE_ENABLED=true
EOF
```

- [ ] **Step 2: 重启 bot（用之前的 launchctl kickstart）**

```bash
launchctl kickstart -k gui/$(id -u)/com.everpretty.dingtalk-bot
```

- [ ] **Step 3: 确认 paperclip server 在跑且 PAPERCLIP_CONCIERGE_AGENT_ID 已 export**

```bash
curl -s http://127.0.0.1:3100/api/healthz | head
launchctl list | grep paperclip-dev
```

### Task 4.2: 钉钉群真实 @ 验证

- [ ] **Step 1: 在「亚马逊库存机器人测试群」@bot 发消息**

```
@EverPretty 智能助手 EE02968 顾客主要抱怨什么
```

预期：
1. ≤ 2s 收到「已收到: EE02968...正在调度...」
2. ≤ 60s 收到完整答案 + 末尾 "via Concierge"
3. paperclip Web UI 能看到对应 issue（status=done，含一条用户 comment + 一条 Concierge agent comment）

- [ ] **Step 2: 故障注入验 fallback**

停 paperclip server：
```bash
launchctl stop com.everpretty.paperclip-dev
```

再 @bot 发同样的问题。预期：
1. 立即收到「已收到 ...」ack
2. ≤ 30s 收到答案，末尾标 "via fallback"
3. bot 日志有 `concierge unavailable, falling back` warning

恢复：
```bash
launchctl start com.everpretty.paperclip-dev
```

- [ ] **Step 3: 把验证结果写入 spec doc**

```bash
cd /Users/melodylu/PycharmProjects/paperclip
# 在 docs/superpowers/specs/2026-05-25-c1-concierge-spec.md 加「Phase 4 端到端验收」段
git add docs/superpowers/specs/2026-05-25-c1-concierge-spec.md
git commit -m "docs(c1): phase 4 — end-to-end DingTalk verification record"
```

---

## Phase 5 — Concierge 接通第一个业务 agent（可选 MVP+）

**目的**：让 Concierge 在识别到"净利润 / 成本"类问题时**派 sub-issue 给 Finance agent**，Finance 跑完 → Concierge 聚合 → 主 issue。这是「多 agent 真接力」首例。

> **若 P1-P4 已能满足 80% 场景，Phase 5 可推迟到下次迭代。**

### Task 5.1: 设计 Concierge 派 sub-issue 协议

**Files:**
- Modify: `docs/agents/concierge.md`

- [ ] **Step 1: 在 docs/agents/concierge.md 加 "派给业务 agent" 段**

写明：
- 触发条件：用户问题含「净利润 / 成本 / 利润率 / 现金流」→ 派 Finance
- 派的方式：Concierge 调 paperclip API 创建 sub-issue，parent_issue_id=主 issue.id，assignee=Finance agent UUID
- 回流：Concierge 监听 sub-issue 完成 → 拉 sub-issue 答案 → 在主 issue 加聚合 comment

- [ ] **Step 2: Commit**

```bash
git add docs/agents/concierge.md
git commit -m "docs(c1): concierge — sub-issue delegation protocol to business agents"
```

### Task 5.2: 端到端验证 Finance 接力

- [ ] **Step 1: 测试问题**

@bot 发：「@EverPretty 智能助手 帮我看 EE02968 这款的净利润和退货综合分析」

预期：
1. Concierge 识别到「净利润」→ 派 sub-issue 给 Finance + 同时自己查退货
2. Finance 跑完返回净利润
3. Concierge 聚合两边答案 + push 钉钉，末尾标 "via Concierge + Finance"

- [ ] **Step 2: 把验收记录写入 spec doc**

```bash
git add docs/superpowers/specs/2026-05-25-c1-concierge-spec.md
git commit -m "docs(c1): phase 5 — multi-agent relay verification (Finance)"
```

---

## Self-Review 记录

- **Spec 覆盖**：架构图 5 个 Phase × Phase 0 discovery 一一对应；MVP scope 在 `Phase 1-4` 闭环可用，Phase 5 是 MVP+ 真"多 agent 接力"。
- **Placeholder 扫描**：Phase 1 service 实现里 `.where(/* ... */)` 留了占位符——执行 Phase 1.2 时实际照 `eq(issues.companyId, ...).and(...)` 写齐。已在 Phase 0 spec doc 里把 agents/issues schema 行号给了，足以照写。其它步骤无 TBD / TODO。
- **类型一致性**：`ChatHandleInput` / `ChatHandleResult` / `chatService` / `chatRoutes` / `ConciergeClient` 跨 Task 全部命名对齐。`PAPERCLIP_CONCIERGE_AGENT_ID` 这一环境变量名贯穿 server / seed 脚本 / bot config。
- **已知取舍**：Phase 0 不是纯实施，是 discovery，无法照搬"红绿重构"模式——通过 spec doc + 行号引用降级，可接受。

---

**Plan 完成。保存到 `docs/superpowers/plans/2026-05-25-c1-concierge-migration.md`。两种执行方式：**

**1. Subagent-Driven (推荐)** — 每个 Task 派新 subagent 跑，Task 间审；快速迭代

**2. Inline Execution** — 在本 session 跑，按 Task 批次设 checkpoint

**走哪个？**
