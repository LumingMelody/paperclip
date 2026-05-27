# C1 — Phase 6.0: Multi-Agent DingTalk Channels — Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单 bot 单 channel 的 `paperclip-dingtalk-bot` 重构成 N-channel-capable —— 同一份代码 + 不同 env 跑 N 个 bot 进程，每个进程对应一个 DingTalk app + 一个 paperclip agent。MVP 目标 N=7 (Concierge + 6 业务 agent: Finance / ProductSizing / Supply / CXOps / Marketing / Research)。

**Why now:** Phase 6 spike (2026-05-27) 已验证 4/4 技术未知 (DingTalk Open API 主动 push 可用、`/api/chat` targetAgentId routing 工作、复合 conversationKey 隔离、端到端 chain)。Phase 6.0 现在做的是工程落地。

**Architecture summary (from Codex Phase 6 review + spike validation):**

```
7 个独立进程，同一代码库，env-driven
├─ concierge bot   →  DingTalk app: EverPretty 智能助手  → targetAgent=Concierge
├─ finance bot     →  DingTalk app: Finance bot            → targetAgent=Finance
├─ ...
└─ research bot    →  DingTalk app: Research bot           → targetAgent=Research

每个 bot:
  - DingTalk Stream 长连接（接 @ 提问）
  - POST /api/chat with targetAgentId + 复合 conversationKey
  - poll issue 到 done
  - DingTalk Open API 主动 push 答案回群（不依赖 reply_markdown）
```

**Tech stack:**
- paperclip-dingtalk-bot: Python 3.13 + dingtalk-stream SDK + httpx (already）
- DingTalk Open API: `/v1.0/oauth2/accessToken` + `/v1.0/robot/groupMessages/send`
- Process supervisor: macOS launchd（user 已用 launchd 管 bot 1 个进程，扩 7 个最自然）
- Per-channel config: `.env.<channel>` 文件 + launchd plist 一对一

---

## 关键架构决策（写在前面避免歧义）

1. **进程模型 = 1 进程 1 channel 1 plist**。不在 Python 里搞 N socket 多路复用。理由：DingTalk Stream 是长连接，任何一个 app 的 SDK 异常 / 凭证错 / 网络抖动不该污染其它 6 个。launchd 已能管 com.everpretty.dingtalk-bot，扩 7 个 plist 是 ops 最省心方案。
2. **`BOT_CHANNEL` env 驱动身份**。每个 bot 进程读 `BOT_CHANNEL=finance` (or `concierge` / `supply` / ...) 决定自己是谁。代码无 if-else 分支；每个 channel 的差异只在 env 文件里。
3. **`.env.<channel>` 命名规范**。`.env.concierge` / `.env.finance` / `.env.supply` ... 在 bot repo 根目录。`.gitignore` 必须排除新模板外的真凭证文件。每个文件包含该 channel 的 DingTalk app credentials + `PAPERCLIP_CHAT_TARGET_AGENT_ID` + `PAPERCLIP_DINGTALK_CONV_ID` + `PAPERCLIP_DINGTALK_ROBOT_CODE`。
4. **复用 conversation_registry**。registry 已经 auto-populate `~/.paperclip/dingtalk_conversations.json` —— Phase 6.0 不改这部分代码，bot 启动后第一次收消息就自动学到自己群的 cid / robot_code，写入 registry，Phase 6.0d 直接 read。
5. **Reply 路径用主动 push，不用 reply_markdown**。这样 future 6.1（agent 主动广播进度）可以直接复用同一 push 代码路径。MVP 阶段先把 reply 改 push，证明 push-based 双向都行。
6. **不动 Concierge agent prompt / paperclip server schema**。Phase 5 + Phase 6 spike 已经把 server 端改好（`targetAgentId` 字段就位）。Phase 6.0 纯 bot 端工程 + ops。

---

## File Structure

```
paperclip-dingtalk-bot/
├─ .env                                       ← 现有（旧单 channel）— Phase 6 后变成 .env.concierge
├─ .env.template                              ← 新：每个 channel 一份的填写模板
├─ .env.concierge / .env.finance / .env.product_sizing /
│  .env.supply / .env.cx_ops / .env.marketing / .env.research
│                                            ← 7 个 channel 实际凭证（gitignored）
├─ config.py                                  ← 改：读 BOT_CHANNEL，dispatch 到对应 .env.<channel>
├─ main.py                                    ← 改：reply path 用主动 push 而不是 reply_markdown
├─ active_push.py                             ← 新：DingTalk Open API 主动 push 封装
├─ concierge_client.py                        ← 微改：post_chat 增加 targetAgentId 透传
└─ scripts/
   ├─ run-channel.sh                          ← 新：单 channel 启动包装（被 launchd 调用）
   └─ install-launchd-plists.sh               ← 新：自动生成 7 个 plist 文件

~/Library/LaunchAgents/
└─ com.everpretty.dingtalk-bot-{channel}.plist  ← 7 个 plist，由 install-launchd-plists.sh 生成

paperclip 仓库（这边）/docs/
├─ guides/everpretty-dingtalk-multi-channel-onboarding.md  ← 新：你做钉钉后台 6 个 app 的完整 checklist
└─ superpowers/specs/
   └─ 2026-05-27-c1-phase6-spec.md            ← 新：实施 + 验证 spec（最后写）
```

**不动**：
- paperclip server 代码（spike 已改好）
- 任何 agent prompt / instructionsBundle
- tool-registry

---

## Phase 1 — Bot 代码 N-channel 改造（用现有 Concierge app 当 channel-0 验证）

### Task 1.1: 加 BOT_CHANNEL env 驱动 + 拆分 .env 文件

**Files:**
- Modify: `paperclip-dingtalk-bot/config.py`
- New: `paperclip-dingtalk-bot/.env.template`
- New: `paperclip-dingtalk-bot/.env.concierge` (从现有 `.env` 改名 + 加 BOT_CHANNEL 字段)
- Modify: `paperclip-dingtalk-bot/.gitignore` (加 `.env.*` 排除，保留 `.env.template`)

- [x] **Step 1: 在 `config.py` 加 channel-aware loading**
  - 读 `BOT_CHANNEL` env (e.g. `concierge`, `finance`, ...)
  - 加载顺序：先 `load_dotenv('.env.{BOT_CHANNEL}')` 再常规 env override
  - 读 `PAPERCLIP_CHAT_TARGET_AGENT_ID`、`PAPERCLIP_DINGTALK_ROBOT_CODE`、`PAPERCLIP_DINGTALK_CONV_ID`
  - 若 `BOT_CHANNEL` 没设 → fallback `concierge` 兼容现状

- [x] **Step 2: 写 `.env.template`** —— 含所有必填字段 + 注释（不含真凭证）

- [x] **Step 3: 现有 `.env` → 改名 `.env.concierge`** 并加 `BOT_CHANNEL=concierge` `PAPERCLIP_CHAT_TARGET_AGENT_ID=40560fc7-...`

- [x] **Step 4: 更新 `.gitignore`** —— 排除 `.env*` 但保留 `.env.template`

- [x] **Step 5: 跑现状 smoke** —— `BOT_CHANNEL=concierge .venv/bin/python -c "import config; config.assert_configured()"` 通过；`BOT_CHANNEL=finance` 时正确缺凭证（无 .env.finance）— 验证 channel routing 工作

- [x] **Step 6: Commit (bot repo)**

### Task 1.2: 抽 `active_push.py` —— DingTalk Open API 主动推送

**Files:**
- New: `paperclip-dingtalk-bot/active_push.py`

- [x] **Step 1: 写 `active_push` module**
  - `class DingTalkActivePush`: 持有 appKey/appSecret/robotCode，缓存 access_token + auto-refresh
  - `def push_markdown(conv_id: str, title: str, text: str)`: 调 `/v1.0/robot/groupMessages/send`
  - 错误处理: 401 → 刷 token 重试一次；429 / 5xx → 指数退避
  - 复用 spike 已经验过的 payload shape (msgKey="sampleMarkdown", msgParam=JSON.stringify({title, text}))

- [x] **Step 2: 写单测** (mock httpx)：happy path + 401 自愈 + token cache + push msgKey 形状
  - 10 tests / 10 pass — covers: happy path, token cache, 401 self-heal once,
    repeated-401 doesn't loop, 5xx backoff success, 429 exhaustion, missing
    creds at construct, missing args at call, 400 non-retryable, token TTL
    refresh. Full bot test suite 24/24 still green.

- [x] **Step 3: Commit (bot repo)**

### Task 1.3: 改 `main.py` reply 路径 → 主动 push

**Files:**
- Modify: `paperclip-dingtalk-bot/main.py`

- [x] **Step 1: 替换 reply_markdown(...) 用 `active_push.push_markdown(conv_id, title, text)`**
  - `conv_id` 从 `ChatbotMessage.conversation_id` 取
  - title / text 同原逻辑
  - reply_markdown **保留**作 fallback —— 万一 active_push 5xx 重试失败仍能回复
  - Implemented via `_reply(handler, chatbot_msg, title, text)` helper +
    module-level `_active_push` singleton with lazy `_ensure_active_push()`
    bootstrap (falls back to incoming message's robot_code if env unset).
    All 10 call sites in main.py swapped — full bot test suite 24/24 still green.

- [x] **Step 2: bot Concierge channel 端到端测**
  - 钉钉群 @bot 一次普通问题（之前能答的）— **deferred to Task 3.1 user @-test**;
    direct live smoke push via active_push from the bot's credentials succeeded
    with `processQueryKey` in 372ms (real DingTalk Open API 200), the network
    path is confirmed.
  - launchctl kickstart succeeded; bot.err.log shows
    `active_push enabled — channel=concierge robot_code=dingtpifhvqq13uoghjw`
    and Stream socket connected normally.

- [x] **Step 3: Commit (bot repo)**

### Task 1.4: `concierge_client.py` 加 targetAgentId 透传

**Files:**
- Modify: `paperclip-dingtalk-bot/concierge_client.py`

- [x] **Step 1: `post_chat` 增加 `target_agent_id` 参数 (Optional[str])，传给 paperclip 的 targetAgentId 字段**
  - Falsy values (None/"") suppressed — server defaults to Concierge dispatch
    when field absent (verified by new unit test `test_post_chat_passes_target_agent_id`).

- [x] **Step 2: `main.py` 调用处补传 `config.PAPERCLIP_CHAT_TARGET_AGENT_ID`**
  - `_concierge_followup` now passes `target_agent_id=(config.PAPERCLIP_CHAT_TARGET_AGENT_ID or None)`.

- [x] **Step 3: Commit (bot repo)**
  - Full test suite: 25/25 pass. Bot restarted via launchctl kickstart and
    boot log shows the new code is live.

---

## Phase 2 — launchd plist 编排 + onboarding 工具

### Task 2.1: 写 `scripts/run-channel.sh`

**Files:**
- New: `paperclip-dingtalk-bot/scripts/run-channel.sh`

- [x] **Step 1: 写 wrapper**
  - 参数 `$1` = channel name (e.g. `finance`)
  - 必要的 pre-flight: 确认 `.env.<channel>` 存在 + 必填字段非空
  - `export BOT_CHANNEL=$1`
  - exec `python main.py`
  - **No pkill** — each plist label is unique so launchd guarantees one
    process per channel; `kickstart -k` handles restart cleanly. Avoids
    the legacy `run.sh` cross-channel kill risk.

- [x] **Step 2: chmod +x**

- [x] **Step 3: Commit (bot repo)** — bundled with Task 2.2 in commit 665a80c.

### Task 2.2: 写 `scripts/install-launchd-plists.sh`

**Files:**
- New: `paperclip-dingtalk-bot/scripts/install-launchd-plists.sh`
- New: `paperclip-dingtalk-bot/scripts/dingtalk-bot.plist.template` (XML)

- [x] **Step 1: 写 plist 模板** —— 含占位符 `{{CHANNEL}}` 和 `{{REPO_ROOT}}`，KeepAlive、StandardOut/ErrPath、ProgramArguments 调 `run-channel.sh`
  - Also added `BOT_CHANNEL` to EnvironmentVariables (belt+suspenders);
    ProcessType=Interactive (matches legacy plist).

- [x] **Step 2: 写 install script**
  - 遍历 7 个 channel: concierge / finance / product_sizing / supply / cx_ops / marketing / research
  - 替换模板占位符 → 生成 7 个 `~/Library/LaunchAgents/com.everpretty.dingtalk-bot-<channel>.plist`
  - `launchctl bootout` 现有 `com.everpretty.dingtalk-bot`（modern bootout, fallback unload）+ archives the old plist file.
  - `launchctl bootstrap` 新 plist（fallback `load -w`）
  - 跳过 .env.<channel> 不存在的 channel（这样部分上线场景能用）

- [x] **Step 3: Commit (bot repo)** — bundled with Task 2.1 in commit 665a80c.

### Task 2.3: 写 Channel onboarding checklist 给 user

**Files:**
- New: `paperclip` 这边 `docs/guides/everpretty-dingtalk-multi-channel-onboarding.md`

- [x] **Step 1: 写 step-by-step 步骤**, 每个 channel 都重复 6 步：
  1. 钉钉开发者后台 → 创建企业内部应用 (具体 URL 路径)
  2. 应用名建议 `EverPretty <AgentName> Bot` (e.g. `EverPretty Finance Bot`)
  3. 配机器人 → 启用 Stream 模式 (具体页面位置)
  4. 权限管理 → 勾选 `chatBotSendMsg` + 群消息接收 (具体权限名)
  5. 把机器人装进对应群（每个 agent 对应一个或多个群）
  6. 在群里 @机器人一次 (任意内容) → 让 bot 自动写 conversation_registry

- [x] **Step 2: 列出每个 channel 要填的 8 个 env 字段** —— 哪个字段从钉钉后台哪个页面取

- [x] **Step 3: 写完试一遍的 smoke**：`bash scripts/run-channel.sh finance` 跑通后再交给 launchd

- [x] **Step 4: Commit (paperclip repo)**
  - File: docs/guides/everpretty-dingtalk-multi-channel-onboarding.md

---

## Phase 3 — 端到端单 channel 验证（用现有 Concierge app）

不依赖 user 创建新 app —— 先用现有 Concierge app 当唯一 channel 跑通**新代码路径**，证明 N-channel 基础设施 work。

### Task 3.1: stop 旧单进程 bot + start 新 launchd 7-plist 套件

- [x] **Step 1: 用 install script 一键切换**
  - Ran `bash paperclip-dingtalk-bot/scripts/install-launchd-plists.sh`. Legacy
    `com.everpretty.dingtalk-bot` plist booted out + archived to
    `~/Library/LaunchAgents/com.everpretty.dingtalk-bot.plist.phase6-archived-20260527180611`.
    New `com.everpretty.dingtalk-bot-concierge` bootstrapped; 6 business
    channels skipped (no .env files yet — that's Phase 4 user work).
  - Refined design vs original plan: install script SKIPS unprovisioned
    channels rather than installing all 7 plists. Plists for finance/supply/
    etc. only land after user creates `.env.<channel>` (Phase 4 onboarding).
    Avoids 6 launchd labels crash-looping with EX_CONFIG.

- [x] **Step 2: ps -ef 验证只有 concierge bot 进程在跑** + lsof 无端口冲突 + DingTalk Stream 连上
  - `launchctl list | grep dingtalk-bot` → exactly one label, PID 88628.
  - `ps -ef | grep main.py | grep paperclip` → exactly one process (PID 88628).
  - bot-concierge.err.log shows: `active_push enabled` + `starting bot — channel=concierge`
    + Stream `open connection` with new ticket. State: running, "last exit code = (never exited)".

- [ ] **Step 3: 钉钉群 @bot 跑一个原 Phase 5 都通过的复合问题** (e.g. EG02084 怎么办 — 已预热)
  - 期望: Concierge 派 3 sub-issue → Finance/ProductSizing/Supply 答 → 聚合 → push 回群
  - 验证: 行为跟 Phase 5 一致；唯一差别是 reply 路径用 active push 不是 reply_markdown
  - **autoloop-deferred** — needs human @-mention in the DingTalk group;
    autoloop cannot dogfood without a user posting the question.

### Task 3.2: 故意把 .env.concierge 删一个字段 验证启动 pre-flight

- [x] **Step 1: 临时备份 `.env.concierge` → 删 `DINGTALK_APP_KEY`**
  - (Used DINGTALK_APP_KEY instead of PAPERCLIP_CONCIERGE_AGENT_ID — APP_KEY
    is in run-channel.sh's preflight `required_keys` list, the more direct
    test of the preflight gate.)

- [x] **Step 2: `launchctl kickstart` concierge plist → 期望 run-channel.sh exit 1 + plist standby**
  - Observed: `last exit code = 78: EX_CONFIG`, state = "spawn scheduled"
    (KeepAlive will retry on ThrottleInterval but won't infinite-spin).
    bot-concierge.err.log captured exact line: `[run-channel.sh]
    /Users/.../.env.concierge missing or empty required key: DINGTALK_APP_KEY`.

- [x] **Step 3: 还原字段 → kickstart → 期望恢复正常**
  - `mv .env.concierge.bak.preflight-test .env.concierge` + kickstart →
    state = running, pid = 89216, Stream socket reconnected with fresh ticket.

---

## Phase 4 — Onboarding 实操 (user-driven, autoloop PAUSE 在这一步)

⚠️ 这一阶段 autoloop **写 .claude/autoloop-blocked.json 暂停**，等 user 在钉钉后台开完 6 个 app + 把凭证填到 .env.<channel> 后，user 再 `/autoloop-start` 续。

### Task 4.1: user 钉钉后台创建 6 个 app

- [x] **Step 1: 按 `docs/guides/everpretty-dingtalk-multi-channel-onboarding.md` 创 6 个 app**
  - User created 6 apps in DingTalk Open Platform: Finance, ProductSizing,
    Supply, CXOps, Marketing, Research. Credentials supplied (Client ID +
    Client Secret). 钉钉 App ID UUIDs recorded as comments in each .env file
    (informational — not used by the SDK).
- [x] **Step 2: 把每个 app 的 appKey / appSecret / robotCode 填到对应 `.env.<channel>`**
  - 6 .env.<channel> files written with APP_KEY, APP_SECRET, the bound
    paperclip agent UUID (TARGET_AGENT_ID), and all shared paperclip routing
    fields. ROBOT_CODE left blank — lazy-init from incoming message's
    `chatbot_msg.robot_code` on first @-mention.
  - All 7 launchd plists bootstrapped via `install-launchd-plists.sh`;
    Stream sockets all connected; bots running PIDs:
    concierge 95094, finance 95098, product_sizing 95102, supply 95111,
    cx_ops 95123, marketing 95146, research 95169.
- [ ] **Step 3: 把每个 bot 装进对应群 + 在群里 @ 一次让 conversation_registry 学到 cid**
  - **autoloop-deferred** — user must add each new bot to its target group
    in DingTalk and @ once; conversation_registry will record (group_id,
    robot_code) automatically when the bot's first ChatbotMessage callback
    fires. After this, run autoloop again — the registry-→-env backfill is
    automatable (see Task 4.2).

### Task 4.2: user 把 6 个 conv_id 填回 .env.<channel>

- [ ] **Step 1: cat `~/.paperclip/dingtalk_conversations.json`** —— 现在应该有 6 个新群条目
- [ ] **Step 2: 把每个群的 `id` 字段对应填到 `.env.<channel>` 的 `PAPERCLIP_DINGTALK_CONV_ID`**

---

## Phase 5 — 7-bot 启动 + 端到端 smoke

### Task 5.1: `launchctl kickstart` 全部 7 个 plist

- [ ] **Step 1: 触发 install-launchd-plists.sh 重新加载（现在 .env.* 全在）**
- [ ] **Step 2: `launchctl list | grep dingtalk-bot` 验证 7 个进程都 running**
- [ ] **Step 3: 每个 channel 的 bot.err.log 都看到「starting bot — channel=...」**

### Task 5.2: 每个新 channel 单独 smoke

- [ ] **Step 1: Finance 群 @ Finance bot 问** `EE02968 利润空间多少？`
  - 期望: bot 走 /api/chat targetAgentId=Finance → Finance agent 答 → bot push 回群
  - via 行不该出现 Concierge

- [ ] **Step 2-6: Supply / ProductSizing / CXOps / Marketing / Research 群各 @ 一次**

- [ ] **Step 7: Concierge 群继续问 Phase 5 风格复合问题** (e.g. `EE41961 该不该停售？`)
  - 期望: 整套 Phase 5 多 agent 接力依然 work (Concierge 派 sub-issue → 业务 agent 写 → 聚合)

### Task 5.3: 写 spec doc

**Files:** `docs/superpowers/specs/2026-05-27-c1-phase6-spec.md`

- [ ] **Step 1: 记录 7 个 channel 实际投产 + 单 channel 双向 chat 截图 / log 摘录 / 失败 case**

- [ ] **Step 2: Commit**

---

## Self-Review 记录

- **N-channel 设计核心是 env 驱动**：代码无 per-channel if-else 分支。新增第 8 个 channel = 加 .env.<channel> + 跑 install script，无需改任何代码。
- **autoloop 在 Phase 3 后 PAUSE**：autoloop 把所有 channel-agnostic 代码 + 模板 + onboarding 文档准备完，然后 `.claude/autoloop-blocked.json` 写明 'need user to provision 6 DingTalk apps' 停止。User 完成 Phase 4 后再续 Phase 5。
- **Concierge channel 是 dogfood**：先用现有 Concierge app 把新基础设施跑通，再让 user 去开新 app。任何重大基础设施 bug 在 user 投入 6 个 app onboarding 之前就会被抓到。
- **可降级运行**：缺任意 .env.<channel> → 该 channel skip，不影响其它 channel。即用户先创 1-2 个新 app 也能跑（不必一次创 6 个）。
- **总预估**：Phase 1 ~5h (bot 代码) + Phase 2 ~2h (plist + onboarding 文档) + Phase 3 ~1h (concierge smoke) = **autoloop 部分 ~1 天**。User 在 Phase 4 的钉钉后台工作 ~1 天（取决于6 个 app 的审批 / 群安装速度）。Phase 5 ~1h (smoke + spec)。总 ~2-3 天 calendar time。
- **Risk 兜底**：如果 active_push 路径在生产中有未发现的边界 case (msgKey 限制 / markdown 渲染差异 / 群类型不兼容)，reply_markdown 保留为 fallback，每个 channel 的 bot 都能 fail-safe 退回 Phase 5 reply 模式。
