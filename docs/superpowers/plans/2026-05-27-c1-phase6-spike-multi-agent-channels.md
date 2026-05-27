# C1 — Phase 6.0 Spike: Multi-Agent DingTalk Channels — Technical Validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 1 天内验证"每个业务 agent 一个独立 DingTalk app"架构的 3 个最大技术未知。**不创建新 DingTalk app**（避免 user 阻塞），用现有的 EverPretty 智能助手 app credentials + 已有测试群完成 spike。Spike 通过后再开 Phase 6.0 plan，由 user 在 DingTalk 后台创建 6 个新 app。

**Why a spike before Phase 6.0:** 主方案（见 Codex review 2026-05-27）有 5 个风险，其中 #1 'DingTalk 主动推送能力没实测过' 是不可降级的 — 如果 app 凭证不允许主动 push（只能 reply_markdown），整个'每个 agent 自己广播状态'架构作废，得退回 webhook-only 方案。

**Architecture being validated:** 见 `2026-05-26-c1-concierge-phase5-multi-agent-dispatch.md` 完结后的 Codex 设计讨论。本 spike 只验证最小可行路径：
1. **主动推送能力**: 用 app credentials 调 DingTalk Open API `/v1.0/robot/groupMessages/send`（或同类）主动推 markdown 到已知 conversationId。**不靠** Stream SDK 的 reply_markdown。
2. **`/api/chat` targetAgentId 扩展**: 接受 `targetAgentId` 参数让创建的 issue assignee 不是 Concierge 而是任意指定 agent。校验 agent ∈ company。
3. **复合 conversationKey 隔离**: 同一用户在不同 bot context 下 senderKey 不撞 — paperclip chat.ts 当前已经把 conversationKey 当 string 用 + 已有 24h reuse 窗口，需验证拿复合 key 真能区分会话。

**Tech Stack:**
- DingTalk Open API: `POST https://api.dingtalk.com/v1.0/robot/groupMessages/send`（主动 push） 或调研同类
- paperclip server: `server/src/routes/chat.ts` + `server/src/services/chat.ts`（已存在，Phase 5 验过）
- 不动 bot 代码（spike 用 curl 模拟 bot 行为，避免污染 paperclip-dingtalk-bot 现状）

---

## 关键架构决策（spike-only — 不入主仓库）

1. **用现有 app 凭证 spike**: DingTalk 开放平台主动推送的 API 与 reply 不同 endpoint —— 如果当前 app 已有 `chatBotSendMsg` 权限，spike 就能跑。Phase 6.0 才区分 6 个新 app。
2. **不写新 Python**: spike 用 `curl` 直接调 DingTalk Open API，避免改 bot 代码增加风险。Phase 6.0 才把验过的能力落到 bot。
3. **`targetAgentId` 改动最小**: 只加 zod schema optional field + chatService 一行改动（`assigneeAgentId: input.targetAgentId ?? deps.conciergeAgentId`）。如果 spike 失败可以一行 revert。
4. **不上 live event / milestone broadcast**: 这些是 Phase 6.1 工作，spike 不验。Spike 只验"双向 @ + 主动 push + targetAgentId 路由"3 件最小事。
5. **测试 conversationKey 直接用真复合 key 形态**: `dingtalk:<robotCode>:<conversationId>:<staffId>` —— 不只是验"能存"，要验"两条不同 key 不复用同一 issue"。

---

## File Structure

```
docs/superpowers/specs/
└─ 2026-05-27-c1-phase6-spike-spec.md  ← spike 结果记录（最后写）

server/src/routes/chat.ts                ← +1 zod field (targetAgentId optional uuid)
server/src/services/chat.ts              ← +1 fallback line (input.targetAgentId ?? conciergeAgentId)
server/src/routes/chat.test.ts (if exists) ← +1 test case
```

**不动**:
- paperclip-dingtalk-bot 代码（spike 用 curl 直接玩 DingTalk API）
- tool-registry
- agents/instructionsBundle

---

## Phase 1 — DingTalk 主动推送能力验证（最不确定，先做）

### Task 1.1: 找到 DingTalk Open API 中"主动推送 markdown 到群"的正确端点

**Files:** 无（纯调研 + curl 实验）

- [ ] **Step 1: 查 DingTalk 开放平台文档**, 确认 app 凭证主动推群消息的 API endpoint
  - 候选 1: `POST /v1.0/robot/groupMessages/send`（OAuth2 endpoint, 用 access_token）
  - 候选 2: `POST /v1.0/robot/messages/batchSend`（批量发送，用 robotCode）
  - 候选 3: 老 webhook URL（被废弃, 不考虑）
  - 找到端点后记到 `decisions.log`

- [ ] **Step 2: 拿现有 app credentials + 测试群 conversationId**
  - 从 bot `.env` / launchd plist 拿 DINGTALK_APP_KEY / DINGTALK_APP_SECRET / ROBOT_CODE
  - 测试群 conversationId: 用 bot 已有的 log（grep `conversation` 找最近一条群消息的 cid）

- [ ] **Step 3: 拿 access_token**
  ```bash
  curl -s "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
    -H 'content-type: application/json' \
    -d "{\"appKey\":\"${DINGTALK_APP_KEY}\",\"appSecret\":\"${DINGTALK_APP_SECRET}\"}"
  ```
  期望返回 `{"accessToken":"...","expireIn":7200}`。如果是 401 / 权限错误，记下来 — 可能需要开放平台后台勾选某项权限。

### Task 1.2: 实测主动 push markdown

- [ ] **Step 1: 用 access_token 调主动 push API**
  ```bash
  curl -sS -X POST "https://api.dingtalk.com/v1.0/robot/groupMessages/send" \
    -H 'content-type: application/json' \
    -H "x-acs-dingtalk-access-token: $ACCESS_TOKEN" \
    -d '{
      "robotCode": "'"$ROBOT_CODE"'",
      "openConversationId": "<test-group-cid>",
      "msgKey": "sampleMarkdown",
      "msgParam": "{\"title\":\"Phase 6 Spike\",\"text\":\"## 测试主动推送\n\nConcierge 没干，是 spike 在主动 push。\"}"
    }'
  ```

- [ ] **Step 2: 在钉钉测试群里看到这条消息了吗？**
  - 看到 ✅ → 主动推送能力可用，Phase 6.0 主架构可行
  - 没看到 / 报错 → 看 response 报错码：
    - `permission denied / 90002`: app 权限没开 → user 去开放平台后台开「机器人主动推送」权限
    - `conversation not found`: conversationId 不对 → 重新取
    - `robotCode invalid`: robotCode 不对 → 从 app 配置页找
    - 其它错误: 记下来上 Codex 讨论
  - **Block 条件**: 如果开放平台明确不允许 app 凭证主动 push（只允许 reply），则 Phase 6.0 架构作废，写 spec doc 标 BLOCKED，转候选 B（server 端做 group webhook 调度）

- [ ] **Step 3: 把 access_token endpoint + push endpoint + 实际能跑的 payload shape 写到 spec doc**

---

## Phase 2 — `/api/chat` targetAgentId 扩展（已知改动，验证一遍）

### Task 2.1: 加 zod field + chatService 路由

- [ ] **Step 1: 改 `server/src/routes/chat.ts`** — `chatRequestSchema` 加：
  ```typescript
  targetAgentId: z.string().uuid().optional(),
  ```

- [ ] **Step 2: 改 `server/src/services/chat.ts`** — `handleIncoming` 里把硬编码 `deps.conciergeAgentId` 改成：
  ```typescript
  assigneeAgentId: input.targetAgentId ?? deps.conciergeAgentId,
  ```
  并把 `ChatHandleInput` interface 加 `targetAgentId?: string` field。

- [ ] **Step 3: tsc --noEmit + 跑现有 chat.test.ts** —— 必须不破坏 Phase 5 行为。

- [ ] **Step 4: Commit**
  ```bash
  git add server/src/routes/chat.ts server/src/services/chat.ts
  git commit -m "feat(c1/phase6-spike): /api/chat 支持 targetAgentId 字段（默认仍 Concierge）"
  ```

### Task 2.2: 验证 targetAgentId 真路由到指定 agent

- [ ] **Step 1: 重启 paperclip dev**（PUT 后 tsx 应该自动重启，但保险）

- [ ] **Step 2: POST 一条 targetAgentId=Finance 的 chat**
  ```bash
  rtk proxy curl -sS -X POST http://127.0.0.1:3100/api/chat \
    -H 'content-type: application/json' \
    -d '{
      "companyId":"a0f62167-5f88-475b-bdc0-3d4cb80184dc",
      "projectId":"bed68dec-ddf6-4aa1-b921-48c4630e92c6",
      "senderKey":"spike-test-finance",
      "targetAgentId":"ffbebaee-4f54-4712-8a7b-4a06ce70d674",
      "text":"Spike Phase 6.0: 直接派给 Finance 而不是 Concierge"
    }'
  ```

- [ ] **Step 3: 拿到 issueId 后 GET 验证 assigneeAgentId**
  ```bash
  rtk proxy curl -fsS http://127.0.0.1:3100/api/issues/<issueId> | grep assigneeAgentId
  ```
  期望: `assigneeAgentId == ffbebaee-...`（Finance UUID）。**不是** Concierge UUID。

- [ ] **Step 4: 等 ~90s 看 Finance agent 是否真接到任务（status in_progress → done）+ 写答复**

- [ ] **Step 5: 验证默认行为没破** — 不带 targetAgentId 时 issue assignee 仍是 Concierge

---

## Phase 3 — 复合 conversationKey 隔离验证

### Task 3.1: 同一 senderKey 不同 conversationKey 不复用 issue

- [ ] **Step 1: POST 两条同 senderKey 但不同 composite conversationKey 的 chat（24h 窗口内）**
  ```bash
  # 模拟 Finance 群里 staff-A 发问
  rtk proxy curl -sS -X POST http://127.0.0.1:3100/api/chat -H 'content-type: application/json' \
    -d '{"companyId":"a0f62167-...","projectId":"bed68dec-...","senderKey":"staff-A","conversationKey":"dingtalk:finance-app:cid-finance-group:staff-A","targetAgentId":"ffbebaee-...","text":"Finance: 我想问账"}'

  # 模拟 Supply 群里 staff-A 发问（同一用户但不同 app/群）
  rtk proxy curl -sS -X POST http://127.0.0.1:3100/api/chat -H 'content-type: application/json' \
    -d '{"companyId":"a0f62167-...","projectId":"bed68dec-...","senderKey":"staff-A","conversationKey":"dingtalk:supply-app:cid-supply-group:staff-A","targetAgentId":"960b5f82-...","text":"Supply: 我想问库存"}'
  ```

- [ ] **Step 2: 验证 paperclip 创建了 2 个 issue（不是复用）**
  - GET /api/companies/<id>/issues?senderKey=staff-A&limit=5
  - 期望: 2 个 created=true，assignee 一个是 Finance 一个是 Supply

- [ ] **Step 3: 同一 conversationKey 再发一条 → 应该复用 issue（验证现有 reuse 行为没破）**

---

## Phase 4 — 端到端整合（用 Phase 1 + 2 + 3 拼一次最小流程）

### Task 4.1: curl 模拟 Finance bot 完整生命周期

- [ ] **Step 1: 模拟"用户 @ Finance bot"** — POST /api/chat with targetAgentId=Finance + composite key

- [ ] **Step 2: 等 Finance agent 跑完（poll /api/issues/:id 看 status）**

- [ ] **Step 3: 拉 Finance 的最终 comment（GET /api/issues/:id/comments）**

- [ ] **Step 4: 用 Phase 1 验过的主动 push API 把 Finance 答复推到测试群**
  - 模拟 future Finance bot 进程的最后一步动作
  - 看老板群里有没有出现这条 markdown

- [ ] **Step 5: 验证：群里看到的内容 = paperclip issue 里 Finance 写的最后一条 comment**

---

## Phase 5 — Spike spec doc

### Task 5.1: 写 spec

**Files:** `docs/superpowers/specs/2026-05-27-c1-phase6-spike-spec.md`

- [ ] **Step 1: 记录每个 Phase 的实际结果**
  - DingTalk 主动 push API endpoint + payload shape + response
  - access_token TTL + 续期策略
  - targetAgentId 改动 diff + 不破坏 Phase 5 验证
  - 复合 conversationKey 实际行为
  - 端到端 curl-only 流程跑通

- [ ] **Step 2: 决策 — Phase 6.0 是否可开**
  - 所有 spike pass → 直接开 Phase 6.0 plan（user 在 DingTalk 后台创 6 个 app + 配凭证 + 6 个 bot 进程）
  - 主动 push 失败 → 写 Plan B（webhook-based broadcast）spec

- [ ] **Step 3: Commit**
  ```bash
  git add docs/superpowers/specs/2026-05-27-c1-phase6-spike-spec.md
  git commit -m "docs(c1/phase6-spike): spec — 主动 push / targetAgentId / 复合 key 全验证"
  ```

---

## Self-Review 记录

- **Scope 控制核心**: 这是个 spike 不是 feature build。3 个未知验完即停，不顺手做 Phase 6.0 的扩展。
- **不阻塞 user**: 不需要新建 DingTalk app（用现有）。所有 spike step 我可自动跑。
- **可 revert**: 唯一 paperclip 代码改动（`/api/chat` 加 optional `targetAgentId`）是 backward-compatible — 不传字段 = Phase 5 完全相同行为。如果决定不进 Phase 6.0 也不需要 revert。
- **预估**: Phase 1（最不确定）2-3 小时；Phase 2（已知改动）1 小时；Phase 3（验 key）30 分钟；Phase 4（拼一遍）1 小时；Phase 5（spec）30 分钟。**总计 ~5-6 小时**，留 buffer 应对 DingTalk API 文档查找耗时，按 1 天估。
- **风险**: Phase 1 Step 2 如果 DingTalk 报权限错，user 需要去开放平台后台开权限 — 这是唯一可能让我 block 的点。会写明 needed_from_user。
