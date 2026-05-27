# Ever-Pretty 钉钉多 channel bot — 上线 onboarding

**更新时间：** 2026-05-27
**机器人代码库：** `~/PycharmProjects/paperclip-dingtalk-bot/`（独立 repo）
**所属架构阶段：** C1 Phase 6.0 — 多 agent · 多 DingTalk app · 多 channel

> 这份文档讲的是：把 Phase 5 跑通的「单 bot 多 sub-issue 接力」**升级**为「**N 个独立 bot 进程 · N 个独立钉钉群 · N 个 paperclip agent**」。其中 N = 7（Concierge + 6 业务 agent）。
>
> 之前那只 `com.everpretty.dingtalk-bot` 一个 plist 一个进程的形态 = **legacy single-channel**。Phase 6 是 7 个 plist 7 个进程 7 个钉钉 app。
>
> 如果你只是来重启那只退货率 bot，看 `everpretty-dingtalk-return-rate-bot.md`，**不是这篇**。

---

## 1. 整体链路

```
                                                  ┌────────────────────────────┐
                                                  │ 钉钉企业内部应用 #1 (Concierge)│
                                                  │ 钉钉企业内部应用 #2 (Finance) │
钉钉群 #1 @Concierge bot 「EE12345 该不该停售」    │   ...                       │
钉钉群 #2 @Finance bot   「EE02968 利润空间多少」  │ 钉钉企业内部应用 #7 (Research)│
钉钉群 #N @<channel> bot ...                       └────────────┬───────────────┘
                                                                │ Stream 长连接（接 @ 提问）
                                                                ▼
            ┌──────────────────────────────────────────────────────────┐
            │ 7 个 launchd 进程 — 同一份 paperclip-dingtalk-bot 代码    │
            │ 区别只在 BOT_CHANNEL env + .env.<channel> 凭证文件         │
            │                                                          │
            │ com.everpretty.dingtalk-bot-concierge                    │
            │ com.everpretty.dingtalk-bot-finance                      │
            │ com.everpretty.dingtalk-bot-product_sizing               │
            │ com.everpretty.dingtalk-bot-supply                       │
            │ com.everpretty.dingtalk-bot-cx_ops                       │
            │ com.everpretty.dingtalk-bot-marketing                    │
            │ com.everpretty.dingtalk-bot-research                     │
            └──────────────────────────────────┬───────────────────────┘
                                               │ POST /api/chat
                                               │   { targetAgentId: <bound agent UUID>,
                                               │     conversationKey: dingtalk:<app>:<conv>:<staff> }
                                               ▼
                          paperclip server (localhost:3100)
                                               │
                                               ▼
                          指定 agent 接管（Concierge / Finance / Supply / ...）
                                               │
                                               ▼
                          答案写 issue comment + push 回钉钉群（DingTalk Open API 主动推送）
```

关键设计点：

1. **进程模型 = 1 channel 1 进程 1 plist**。任何一个 channel 的 Stream 连接异常 / 凭证错 / 钉钉抽风都不污染其它 6 个。
2. **`BOT_CHANNEL` env 驱动身份**。代码无 `if channel == "finance"` 分支；每个 channel 的差异只在 `.env.<channel>` 里。
3. **`PAPERCLIP_CHAT_TARGET_AGENT_ID` 是直达路由**。Finance bot 把 targetAgentId 设成 Finance agent 的 UUID，paperclip server 跳过 Concierge 派单，直接 assign 给 Finance。Concierge bot 把它设成 Concierge 自己的 UUID —— 行为跟 Phase 5 一模一样，零回归。
4. **回复用 DingTalk Open API 主动推送**，不走 Stream SDK 的 `reply_markdown`。这样 Phase 6.1（agent 主动广播进度）能直接复用同一 push 代码路径；Stream `reply_markdown` 保留为 fallback。

---

## 2. 单 channel onboarding — 6 步标准动作

每个新业务 channel（finance / product_sizing / supply / cx_ops / marketing / research）都重复以下 6 步。**第 1 个 channel（concierge）由 Phase 6.0 dogfood 完成，复用现有 app，跳过 Step 1-4，只走 Step 5-6**。

### Step 1：钉钉开发者后台创建企业内部应用

1. 访问 [开发者后台](https://open-dev.dingtalk.com/) → 选择 Ever-Pretty 企业。
2. 左侧 **应用开发 → 企业内部应用 → 创建应用**。
3. 应用类型选 **企业内部开发** → **小程序与机器人 → 机器人**。
4. **应用名建议**（保持品牌一致）：

   | channel           | 钉钉应用名                       | paperclip agent           |
   |-------------------|----------------------------------|---------------------------|
   | concierge         | EverPretty 智能助手（已存在）      | Concierge                 |
   | finance           | EverPretty Finance Bot           | Finance                   |
   | product_sizing    | EverPretty Product Sizing Bot    | ProductSizing             |
   | supply            | EverPretty Supply Bot            | Supply                    |
   | cx_ops            | EverPretty CX Ops Bot            | CXOps                     |
   | marketing         | EverPretty Marketing Bot         | Marketing                 |
   | research          | EverPretty Research Bot          | Research                  |

5. 应用图标可以先用默认，回头再换。

### Step 2：配机器人，启用 Stream 模式

1. 进入新建好的应用 → 左侧 **机器人** 标签 → **创建机器人** 或 **配置**。
2. 关键开关：**接收消息模式 = Stream**（不要选 HTTP/Webhook）。
3. 消息会话类型勾选「@机器人」即可，不需要群聊管理类的高权限。

### Step 3：权限管理 — 必勾的两条

1. 进入应用 → 左侧 **权限管理** → **添加权限**。
2. 必须勾选：
   - **`Chatbot.SendMessage`**（即 `chatBotSendMsg`） — 机器人主动发群消息；这是 Phase 6 主动推送的核心权限。
   - **群消息接收** —— 让 Stream 能收到 @ 事件。
3. 保存后等钉钉后台审批（一般几分钟，不需要走企业 OA 审批）。

### Step 4：把机器人装进对应群 + 首次 @ 唤醒

1. 在钉钉 PC / 手机端进入要接管的群。
2. 群设置 → **群机器人** → **添加机器人** → 在「企业内部机器人」里找到刚建的应用 → 添加。
3. 在群里 **@刚加的机器人** 一次，内容随意（例如「测试一下」）。机器人会被 paperclip-dingtalk-bot 的 `conversation_registry` 自动记录到 `~/.paperclip/dingtalk_conversations.json`，包含本群的 `openConversationId` 和 `robotCode`。

### Step 5：填 `.env.<channel>` 凭证文件

```bash
cd ~/PycharmProjects/paperclip-dingtalk-bot
cp .env.template .env.finance       # 改成你正在做的 channel 名
$EDITOR .env.finance
```

填字段对照表见下方 §3。Step 4 触发的 conversation_registry 现在应该已经有这个群的信息了，可以直接抄过来：

```bash
cat ~/.paperclip/dingtalk_conversations.json
```

把对应群的 `id`（即 `openConversationId`）和 `robot_code` 抄到 `PAPERCLIP_DINGTALK_CONV_ID` 和 `PAPERCLIP_DINGTALK_ROBOT_CODE`。

### Step 6：安装 launchd plist 并启动

```bash
cd ~/PycharmProjects/paperclip-dingtalk-bot
bash scripts/install-launchd-plists.sh
```

install 脚本会：

1. 把老的 `com.everpretty.dingtalk-bot.plist`（单 channel 版）bootout + archive（一次性，已经做过就跳过）。
2. 遍历 `concierge` / `finance` / `product_sizing` / `supply` / `cx_ops` / `marketing` / `research` 七个 channel：
   - 有 `.env.<channel>` → 渲染模板 → 写到 `~/Library/LaunchAgents/com.everpretty.dingtalk-bot-<channel>.plist` → `launchctl bootstrap`。
   - 没有 → 跳过这个 channel（**这就是 Phase 6 增量上线的关键**：用户先做一个 channel 也能跑）。

跑完 install 后：

```bash
launchctl list | grep dingtalk-bot   # 看 7 个 label，PID 都是数字代表正在跑
tail -f _logs/bot-<channel>.err.log   # 找你刚启的 channel 看 "starting bot — channel=..." 一行
```

钉钉群里再 @ 一次机器人测试，应该 5-30 秒收到 paperclip agent 的回复。

---

## 3. `.env.<channel>` 字段对照表（8 个必填字段）

每个 channel 的 `.env.<channel>` 必须填这 8 个字段，其它字段可以共用默认值：

| 字段                              | 从哪里取                                                                  | 例子                                              |
|-----------------------------------|---------------------------------------------------------------------------|---------------------------------------------------|
| `BOT_CHANNEL`                     | 文件名自己（concierge / finance / ...）                                    | `finance`                                         |
| `DINGTALK_APP_KEY`                | 钉钉后台 → 应用 → 凭证与基础信息 → **AppKey**                              | `dingtX1Y2Z3...`                                  |
| `DINGTALK_APP_SECRET`             | 钉钉后台 → 应用 → 凭证与基础信息 → **AppSecret**                           | `64-char-secret`                                  |
| `PAPERCLIP_CONCIERGE_AGENT_ID`    | paperclip Web UI → Agents → 找 **Concierge** → 复制 UUID                  | `40560fc7-a40b-4106-806f-95a7060c8e0b`            |
| `PAPERCLIP_CHAT_TARGET_AGENT_ID`  | paperclip Web UI → Agents → 找 **本 channel 绑的 agent** → 复制 UUID       | `<Finance agent UUID>`                            |
| `PAPERCLIP_DINGTALK_CONV_ID`      | Step 4 触发后，`~/.paperclip/dingtalk_conversations.json` 里本群的 `id`     | `cidA5thWvMwxiqbGecf4MjdjQ==`                     |
| `PAPERCLIP_DINGTALK_ROBOT_CODE`   | 同上文件的 `robot_code` 字段                                              | `dingtpifhvqq13uoghjw`                            |
| `LLM_API_KEY` *(可选)*            | tabcode 控制台 → API Keys（用于 LLM dispatcher 兜底；不填关闭兜底）         | `sk-user-...`                                     |

Concierge channel 的两个 agent UUID **相同**（都是 Concierge 自己） —— 这样 targetAgentId 直达自己，效果等同 Phase 5 默认派单。

剩余字段（`PAPERCLIP_BASE_URL` / `PAPERCLIP_COMPANY_ID` / `PAPERCLIP_PROJECT_ID` / `PCL_TOOLS_BIN` / `LLM_BASE_URL` / `LLM_MODEL` / ...）所有 channel 共用，从 `.env.template` 拷过来不用改。

---

## 4. 单 channel smoke procedure（不依赖 launchd）

新填好的 `.env.<channel>` 在没装 plist 之前，可以先手跑一次确认链路通：

```bash
cd ~/PycharmProjects/paperclip-dingtalk-bot
bash scripts/run-channel.sh finance        # 改成你的 channel
```

预期：

```
[run-channel.sh] starting bot channel=finance cwd=/Users/melodylu/PycharmProjects/paperclip-dingtalk-bot
... INFO paperclip-dingtalk-bot: active_push enabled — channel=finance robot_code=...
... INFO paperclip-dingtalk-bot: starting bot — channel=finance company=... default-issue=DINGTALK-BOT pcl-tools=... llm=on (...)
... INFO dingtalk_stream.client: open connection, url=https://api.dingtalk.com/v1.0/gateway/connections/open
```

群里 @机器人问一句业务相关的话，应该 5-30 秒内收到 paperclip agent 的回复。Ctrl-C 停掉手跑的进程，再跑 `bash scripts/install-launchd-plists.sh` 把这个 channel 移交给 launchd 管理。

**注意：手跑 + launchd 同时跑 = 双进程抢同一个 appKey 的钉钉 Stream 连接** = 消息会被随机一个进程拿走。**确认手跑成功后必须 Ctrl-C，再装 plist。**

---

## 5. Phase 6.0 dogfood — 老版 → 新版的一次性切换

这步是从 legacy `com.everpretty.dingtalk-bot` 单 channel 切到 Phase 6 七 channel 的一次性过渡。`.env.concierge` 已经在 commit `17312f6` 备好凭证（从老 `.env` 改名 + 加了两行），跑一次 install 就完成切换：

```bash
cd ~/PycharmProjects/paperclip-dingtalk-bot
bash scripts/install-launchd-plists.sh
```

预期 summary：

```
Installed (1): concierge
Skipped (6):
  - finance (no .env.finance)
  - product_sizing (no .env.product_sizing)
  - ...
```

`launchctl list | grep dingtalk-bot` 应该只剩 `com.everpretty.dingtalk-bot-concierge`，老的 `com.everpretty.dingtalk-bot`（无 `-concierge` 后缀）已经 bootout 并 archive 到 `~/Library/LaunchAgents/com.everpretty.dingtalk-bot.plist.phase6-archived-<timestamp>`。

钉钉群里 @ 智能助手跑一个 Phase 5 测试过的复合问题（例如「EG02084 该不该停售」），预期 Concierge → 3 个 sub-issue 派单 → Finance/ProductSizing/Supply 答 → 聚合 → 主动 push 回群，跟 Phase 5 一模一样。

回退方法（如果 Phase 6 切换有 bug）：

```bash
launchctl bootout gui/$(id -u)/com.everpretty.dingtalk-bot-concierge
mv ~/Library/LaunchAgents/com.everpretty.dingtalk-bot.plist.phase6-archived-* ~/Library/LaunchAgents/com.everpretty.dingtalk-bot.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.everpretty.dingtalk-bot.plist
```

---

## 6. Troubleshooting cheatsheet

| 症状                                            | 看哪里                                                                 |
|-------------------------------------------------|------------------------------------------------------------------------|
| 群里 @ 后无反应                                 | `_logs/bot-<channel>.err.log` 尾部 — 看 Stream 是否连上                  |
| 启动立刻退出 exit=78                            | run-channel.sh 提示了具体缺哪个字段 → 回 `.env.<channel>` 补齐           |
| 启动后 `active_push disabled` 警告               | `ROBOT_CODE` 没填，去 `~/.paperclip/dingtalk_conversations.json` 抄一遍 |
| 回复发到错的群                                  | `PAPERCLIP_DINGTALK_CONV_ID` 填的不是本群的 `id`                        |
| 跑的是老代码                                    | `git log -1` in `paperclip-dingtalk-bot` repo 看 commit 是否最新；`launchctl kickstart -k gui/$(id -u)/com.everpretty.dingtalk-bot-<channel>` 强重启 |
| 两个 channel 抢同一个 app（消息掉一半）         | `ps -ef \| grep main.py` 看是不是有手跑残留没杀；用 `bash scripts/install-launchd-plists.sh` 重新装一遍会清理 |
| paperclip 服务起不来                            | `~/PycharmProjects/paperclip` 这边 `pnpm dev` 重启；bot 端 `_logs/...err.log` 里会看到 `ConciergeUnavailable` 异常 |

---

## 7. 相关文档

- `docs/superpowers/specs/2026-05-27-c1-phase6-spike-spec.md` — Phase 6.0 spike 4/4 技术未知验证记录。
- `docs/superpowers/plans/2026-05-27-c1-phase6-multi-agent-channels.md` — Phase 6.0 完整 plan（autoloop 跑这份）。
- `docs/guides/everpretty-dingtalk-return-rate-bot.md` — legacy（Pattern C LLM dispatcher）退货率 bot 的设计文档。Phase 6 之后这只 bot 已经迁到 Concierge channel，但里头讲的 RAG vs DWS 分流规则仍然适用。
