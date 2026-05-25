# C1 Concierge 迁移 — 技术 spec

**日期**：2026-05-25
**关联 plan**：[`docs/superpowers/plans/2026-05-25-c1-concierge-migration.md`](../plans/2026-05-25-c1-concierge-migration.md)
**性质**：Phase 0 discovery 产出。所有 Phase 1+ 实施依据。

---

## 1. paperclip agent runtime 模型

**一句话总结**：agent 是数据库记录 + 一种 "adapter type"。每次 agent 被唤醒，paperclip server **spawn 一个 adapter subprocess**（如 `claude` CLI / `codex` CLI），把 agent 的 prompt/工具/上下文通过 stdin / env / 临时文件喂给 subprocess，由 subprocess 完成 LLM 调用 + 工具执行。

**关键文件 / 行号**：

| 内容 | 文件:行号 |
|---|---|
| agents 表 schema（adapterType / runtimeConfig / adapterConfig）| `packages/db/src/schema/agents.ts:26-29` |
| Builtin adapter types 白名单（10 种）| `server/src/adapters/builtin-adapter-types.ts:4-15` |
| Adapter registry（getServerAdapter / register / unregister）| `server/src/adapters/registry.ts:415, 425, 449` |
| heartbeat 调 adapter 的入口 | `server/src/services/heartbeat.ts:41` (`import { getServerAdapter, runningProcesses }`) |
| claude-local adapter subprocess spawn | `packages/adapters/claude-local/src/server/execute.ts:159` |
| Issue assignment wakeup（触发 agent 唤醒）| `server/src/services/issue-assignment-wakeup.ts:21-48` (`queueIssueAssignmentWakeup`) |
| agent.run.* lifecycle events 发布点 | `server/src/services/heartbeat.ts:2734-2740` |

**Builtin adapter types** (`server/src/adapters/builtin-adapter-types.ts`):

```
claude_local | codex_local | cursor | gemini_local | openclaw_gateway
opencode_local | pi_local | hermes_local | process | http
```

**agent record 字段**（与 Concierge 配置相关）:

| 字段 | 类型 | 用途 |
|---|---|---|
| `id` | uuid PK | Concierge agent UUID（要存到 `PAPERCLIP_CONCIERGE_AGENT_ID` env）|
| `companyId` | uuid FK | 所属公司 |
| `name` | text | "Concierge" |
| `role` | text | "general" 或 "concierge" |
| `adapterType` | text | **选 `claude_local`**（其他 agent 大概率也用这个）|
| `adapterConfig` | jsonb | adapter 启动参数（claude CLI 的 flags 等）|
| `runtimeConfig` | jsonb | **agent prompt + tool whitelist 存这里** |
| `capabilities` | text | 角色说明（可选）|
| `status` | text | 默认 "idle" |
| `budgetMonthlyCents` | int | 月预算，C1 可设 0（不收紧）|

**重要**：`instructions` 列**不存在**。agent 的 system prompt 实际存在 `runtimeConfig.prompt` 或类似字段——具体路径要看一个 working agent（Finance）的 runtimeConfig dump 才能确认。Phase 2 seed 脚本要先查现有 agent 的 runtimeConfig schema 再依葫芦画瓢。

## 2. LLM provider 现状

**paperclip server 进程本身不直接调 Anthropic / OpenAI SDK**。所有 LLM 调用走 adapter subprocess：

- `claude_local` adapter → spawn `claude` CLI → 由 CLI 用 **本地 Anthropic OAuth subscription**（或可选 `ANTHROPIC_API_KEY` 覆盖）调 Anthropic
- `codex_local` adapter → spawn `codex` CLI → 用 `OPENAI_API_KEY`
- `cursor` adapter → cursor 自己的 token

**对应证据**：
- `packages/adapters/claude-local/src/server/test.ts:153` — 检查 `ANTHROPIC_API_KEY` 是否会覆盖 OAuth subscription
- `server/src/adapters/codex-models.ts:35` — `process.env.OPENAI_API_KEY?.trim()` 用于 codex
- `packages/adapters/claude-local/src/server/quota.ts:213` — 用 `https://api.anthropic.com/api/oauth/usage` 拉 OAuth quota

**结论 / Concierge 用什么 LLM**：
- **首选 `adapterType: "claude_local"`**——跟现役 Finance/CXOps/DataPlatform agent 同栈，主路径走本地 Claude OAuth subscription，**完全不撞 bot 当前的 tabcode 402 余额耗尽问题**
- 不需要在 paperclip server 进程中配 ANTHROPIC_API_KEY；subprocess 启动时继承 host 已登录的 Claude OAuth

**副作用**：bot 主路径（走 Concierge）零 LLM 钱；bot fallback 路径仍走 tabcode，所以 tabcode 充值不是 Phase 4 blocker——fallback 走得通就行（如果 tabcode 没钱，fallback 也撞 402，那是另一回事，可在 Phase 4 验证时单独决策）。

## 3. Issue 状态变更钩子

**没有 webhook / pub-sub** 系统钩子。只有 in-memory `EventEmitter` 用于 live WebSocket 事件：

- `server/src/services/live-events.ts:27-34` — `publishLiveEvent({companyId, type, payload})`
- 这个 emitter 是单进程内存，bot 跨进程订阅没意义

**Issue status 变化触发点**：
- `server/src/services/issues.ts` 的 `updateStatus` / 类似函数会调用 `publishLiveEvent`，发布 `issue.updated` 事件
- 但**没有专门的 "issue.done" 事件**——只能在 `issue.updated` payload 里读 status

**bot 端的策略**（Phase 3 实施依据）：
- **MVP 用短轮询**：每 5s 调 `GET /api/issues/:id`，看 `status` 是否变 `done` / `cancelled`，超时 5min
- 单用户单群体场景下 5s 延迟可接受
- 实现最简单、不需要 WebSocket 客户端 + reconnect
- v2 升级 WebSocket 留 future（如果延迟成为体感问题）

## 4. 既有 chat-like 端点 + 数据模型复用

**直接复用现有 issue + issue_comments 作"会话"容器**，不新建 ChatSession 表：

| 端点 | 文件:行号 | 用途 |
|---|---|---|
| `POST /api/issues` | `server/src/routes/issues.ts` | 创建 issue —— C1 `/api/chat` 内部走类似流程 |
| `POST /api/issues/:id/comments` | `server/src/routes/issues.ts:3621` | 加 comment —— C1 用户消息 + Concierge 答案都用这个 |
| `GET /api/issues/:id` | `server/src/routes/issues.ts` | 查 issue 状态 —— bot 轮询用 |
| `GET /api/issues/:id/comments` | `server/src/routes/issues.ts` | 列 comment —— bot 拿 Concierge 答案用 |

**数据模型**：

`issue_comments` (`packages/db/src/schema/issue_comments.ts:7-36`):
- `id` uuid PK
- `issue_id` uuid FK
- `author_agent_id` uuid (FK agents) — Concierge 写答案时用这个
- `author_user_id` text — bot 写用户消息时用 DingTalk senderKey
- `body` text — markdown 内容
- `created_at` timestamp

## 5. 关键 schema 改动（C1 唯一需要的 migration）

`issues` 表加 `dingtalk_conversation_key` 列 + 复合索引（用于按 senderKey 找最近未完成 issue）。详见 plan Task 1.3。

```sql
ALTER TABLE "issues" ADD COLUMN "dingtalk_conversation_key" text;
CREATE INDEX "issues_dingtalk_conv_key_status_idx" ON "issues"
  USING btree ("company_id", "dingtalk_conversation_key", "status");
```

**编号**：当前最大 migration 是 `0075_giant_lorna_dane.sql`，新文件用 `0076`。

## 6. 测试栈

- **Server**: Vitest + fork pool. Config: `server/vitest.config.ts`
- **测试样例**: `server/src/__tests__/monthly-spend-service.test.ts:1-50`（vitest + mock-chain pattern）
- **Routes 测试**: 用 `supertest` 包 express app（参考 `__tests__/` 下任一 routes 测试）

## 7. C1 关键决策记录

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | "会话"用什么容器 | issue + issue_comments 复用 | 不增加新表，跟 paperclip 现有抽象一致 |
| D2 | bot 检测 issue done | 短轮询 5s 间隔 / 5min 超时 | MVP 简单；WebSocket 留 v2 |
| D3 | Concierge agent adapter | `claude_local` | 跟现役 Finance/CXOps/DataPlatform 同栈，主路径用 Claude OAuth 不撞 tabcode 余额 |
| D4 | DingTalk push 在哪做 | bot 端做（paperclip 不沾 DingTalk）| 解耦：paperclip 只产 markdown 答案，bot 负责协议适配 |
| D5 | bot fallback 路径 | 保留 `llm_dispatcher.py` | paperclip 不可用时 bot 仍能答；上线后稳定 N 周再砍 |
| D6 | Concierge prompt 存哪 | `runtimeConfig` jsonb（不是不存在的 `instructions` 列）| 跟 schema 实际匹配，具体子字段 Phase 2 看 Finance agent runtimeConfig 后定 |
| D7 | "Phase 0 必须先 inline 跑" | autoloop 接管后 P0 也用 autoloop 走 | 用户已 explicitly autoloop 整套，决策权交出 |

## 8. Phase 0 验收清单

- [x] Step 1 完成：grep agent 执行路径，确认 adapter subprocess 模型
- [x] Step 2 完成：找 LLM provider 调用点，确认主路径走本地 Claude OAuth
- [x] Step 3 完成：本 spec doc 写就
- [ ] Step 4 commit
- [ ] Task 0.2 issue done 钩子已在 §3 落定（短轮询策略）

## 9. Phase 2 验收记录

（Phase 2 完成后追加 Concierge agent UUID + 首次端到端测试 issue ID + 时间戳）

## 10. Phase 4 端到端验收

（Phase 4 完成后追加钉钉群验证截图 / 时间戳 / fallback 注入结果）
