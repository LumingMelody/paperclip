# EverPretty AI 系统进度快照（2026-05-25）

**日期**：2026-05-25
**状态**：RAG 服务上线 + 多市场覆盖 + 周报自动化已完成。MVP 用户问答 / 主动推送两条链路都跑通了。
**前序快照**：[`2026-05-07-progress-snapshot.md`](2026-05-07-progress-snapshot.md)（18 天前）
**关联文档**：
- `2026-05-07-everpretty-bot-future-roadmap.md`（38 项 backlog）
- `2026-04-27-everpretty-ai-roadmap.md`（Phase 1 已交付清单）
- `2026-05-13~2026-05-20-paperclip-rag-*.md`（RAG 相关 plan/spec）

---

## 📍 一句话总结

**paperclip × Ever-Pretty 在 5/13–5/25 把 RAG 从"零"做到"全 8 个 EP 市场分层采样 + 每周自动推退货周报"；问答（被动）和周报（主动）两条业务链路都进入日常运行状态，下一步要等真实使用反馈。**

---

## 🟢 在跑的服务

| 服务 | 类型 | 用途 |
|---|---|---|
| `com.everpretty.dingtalk-bot` | launchd KeepAlive | 钉钉用户问答入口（Pattern C dispatcher）|
| `com.everpretty.paperclip-dev` | launchd KeepAlive | paperclip Web UI / agent 平台（:3100）|
| **`com.everpretty.paperclip-rag-ingest`** ⭐ | launchd 每天 04:00 | RAG 退货评论增量灌入（since=14d ago / dedup 走 manifest）|
| **`com.everpretty.paperclip-rag-weekly-report`** ⭐ | launchd 每周一 09:00 | 退货周报自动推钉钉测试群 |
| **RAG 服务（manual nohup）** ⭐ | `:9001`，孤儿进程 | LightRAG + LM Studio 检索接口（被 bot 和周报脚本调用）|

⭐ = 5/7 之后新增。

**已知运维债**：RAG 服务不是 launchd 托管，Mac 重启会丢；目前手动 `services/rag/scripts/run_dev.sh` 起。如频繁重启再考虑 launchd 化。

---

## 🛠 工具层（22 个，+1 新增）

| Source | 数 | 工具 |
|---|---:|---|
| `lingxing` | 4 | factSku / factOrders / topSkus / stockoutRisk |
| `dws` | 6 | returnReasons / returnsBySku / returnDetail / refundComments / returnTrend / skusByReason |
| `meta` | 2 | adAccountSummary / adsetPerformance |
| `shopify` | 2 | getProduct / listProductsByCollection |
| `spapi` | 2 | getOrder / listOrdersUpdatedSince |
| `admin` | 5 | briefs.parse / costs.rollup / decisions.search / registry.list / toolCalls.search |
| **`rag`** | **1** | **searchRefundComments** ⭐（语义召回 + KG，跨全 8 EP 市场）|

---

## 🧠 RAG 服务（新章节）

**形态**：本地 LightRAG-hku + LM Studio 后端 + nano-vectordb（JSON 文件，全离线）。

**collection**：`refund_comments`（线上，**~8190 个唯一文档**覆盖 8 个 EP 市场退货评论）。

**ingest 策略**：分层采样——按 `(sku_left7, returnReason)` 分组、每组按 `check_date DESC` 取最新 N=8 条。原因：US 单市场就有 ~8 万行原始评论，扁平 LIMIT 取最新 N 条会严重漏采（错过大部分 SKU）。分层后总量可控（~14k docs 上限）且覆盖全 styles × 全 reasons。

**LM Studio 模型**：
- LLM: `qwen/qwen3-30b-a3b-2507`（实体抽取 + 答案合成）
- Embedding: `text-embedding-bge-m3`（1024-dim，多语言原生，中英文都不用译）

**关键能力（5/13–5/25 累计交付）**：
- ✅ 中文 query 直接喂模型（bge-m3 多语言），免去 CN→EN 翻译步骤
- ✅ chunks/entities/relations/references 四类返回字段齐全
- ✅ /index 透传 `file_path`，references 形如 `EP-US/EE02968CH08-USA/113-9003134-...`
- ✅ 8 个 EP 市场跨市场召回
- ✅ 分批 POST 自动拆 (`--batch-size 300`)，避免单批 4h 超时
- ✅ 每日增量 cron 自动跑
- ✅ Bot 接入：`rag.searchRefundComments` 工具 + system prompt 明确「为什么退/主要抱怨」类问题走 RAG

**当前局限**：
- ❌ RAG 无日期参数（按设计——语义召回不分时间窗）。Bot prompt 已显式禁止"近 N 天 X 抱怨"这种暗示日期范围的措辞。需要按时间窗的退货明细走 `dws.refundComments`。
- ❌ RAG 服务 4 小时单请求上限（已通过 ingest 端分批规避；search 端单次问答 <30s 通常不撞）

---

## 🤖 paperclip Agents（10 个，状态无变化）

| Agent | 状态 |
|---|---|
| CXOps / DataPlatform / Finance | 跑过（沿用 5/7 Phase 1 issues）|
| CEO / CMO / Marketing / ProductSizing / Research / Supply / CTO | 架在那 |

**真在跑** 3/10。RAG 阶段没有派 issue 给新 agent；agent 平台业务上没新动作。

---

## 🟡 钉钉 Bot 能力（增量）

5/7 已能力清单全保留。**5/22–5/25 新增**：

### 新增能力
- `rag.searchRefundComments` 工具调用——"EE02968 顾客主要抱怨什么"类语义问题不再靠 LLM 自己脑补，走 RAG 拿带客户原话的中文综合答案
- 全 8 个 EP 市场支持（shop 参数可选，省略=跨市场召回）
- 主动推送：每周一 09:00 退货周报（4 段式 markdown：现状 / Top SKU / Top reason / 客户语义抱怨 / 多市场异常）

### 修复的 bug
- **跟进轮强制重调 RAG**：之前 bot 在跟进轮看到历史里有该 SKU 的 dws 退货数据就直接拿来作答（"近 14 天退货=0 故无产品抱怨"），与 RAG 真实证据相反。Prompt 加硬规则：开放式「为什么退」问题每轮都必须重调 `rag.searchRefundComments`。
- **不再编"近 N 天"框定**：RAG 无日期过滤，bot 之前会把全量召回结果说成"近 14 天"。Prompt 加 caveat。
- **B2 后过期文案**：删掉"该 shop 还没接 RAG"的旧错误提示。

### 仍未做（同 5/7）
- ❌ 不能创建/读 paperclip issue
- ❌ paperclip agent 跑完不能 push 钉钉
- ❌ 不能跨渠道（只钉钉）
- ❌ 没 prompt cache（tabcode 网关限制）

---

## 🔴 已知架构债 + 数据债

### Debt-1（5/7 已记录）：钉钉 bot 是平行的 mini agent 平台
状态不变。需要 Concierge agent 才能解。触发条件仍未到（单用户单平台，迁移成本 ~3-4 天）。

### Debt-2 ⚠️（5/25 加剧）：DWS 退货 `other` 类占比从 51% → **73.7%**
本周（5/18–5/25）EP-US 退货 reason 分布显示 `other` 占 73.7%（5/7 snapshot 时 51%）。要么 Amazon 改了 reason code 上报规则、要么 DW 同事的映射规则漏了新代码。**待跟 DW 同事核实**，否则 RAG 之外的结构化退货分析会越来越虚。

### Debt-3：RAG 服务非 launchd 托管
Mac 重启 RAG 服务会丢，cron 接下来跑会失败（preflight skip）。低优先：单用户、Mac 长期不重启。

---

## 📋 Backlog 进展（38 项里）

| 组 | 5/7 总数 | 已完成 | 进行中 | 备注 |
|---|---:|---:|---:|---|
| TODO-A bot↔paperclip 联动 | 4 | 0 | 0 | 未启动 |
| TODO-B 退货分析能力扩展 | 5 | **B2 file_path/references** | 0 | B2 表面看是 backlog 的 B2，但实际是 RAG 内部修复，不算 backlog 进度 |
| TODO-C Agent 化扩展 | 6 | **C3 定时退货周报** ✅ | 0 | C3 提前做完（原计划 5/28 二次复盘点）|
| TODO-D 数据源扩展 | 3 | 0 | 0 | amazon_reviews 仍 ~84 行（D2 卡住）|
| TODO-E 体验/性能 | 4 | 0 | 0 | tabcode 仍在用，prompt cache 仍无 |
| TODO-F 运维/可观测 | 3 | 0 | 0 | 没人催，没动 |
| TODO-G 21 工具覆盖盘点 | 13 | 0 | 0 | 等真实使用反馈，没人催 |

**额外 RAG 链路（不在原 5/7 backlog 但已交付）**：
- A1 RAG chunks-empty fix
- A2 references hallucination fix
- B1 RAG as DingTalk-bot tool（rag.searchRefundComments 工具化）
- C1 多语言 embedding（bge-m3 切换）
- C1-2 CN/EN 查询翻译（后被 bge-m3 取代）
- B2 多账号 ingest（全 8 EP 市场）
- 分层采样修复（per-(sku, reason) top-N）
- post_docs 分批（防 4h 超时）
- launchd ingest cron（每天 04:00）
- launchd 周报推送（每周一 09:00）

---

## 🌐 仓库

| 仓 | URL | 最新 commit |
|---|---|---|
| paperclip（fork）| LumingMelody/paperclip | `aaad149b` |
| 钉钉 bot | LumingMelody/paperclip-dingtalk-bot | `a961db0` |

上游 `paperclipai/paperclip`：**ahead 116 / behind 63**（5/7 时 ahead 23 / behind 63）。**同步债加剧**：18 天又多了 93 个本地 commit 没合上游。

---

## 🧭 完成度评估

| Phase | 5/7 完成度 | 5/25 完成度 | 变化 |
|---|---|---|---|
| Phase 0 — 基建 | 100% | 100% | — |
| Phase 1 — 数据中台 + MVP | 95% | **100%** | +RAG/22 工具/cron/周报 |
| Phase 2 — 横向 agent 复制 | 25% | 25% | 不变（agent 没新动作）|
| Phase 3 — 全栈 + 治理 + 闭环 | 5% | 10% | +主动产出（周报）算半步 |

---

## ⏭️ 下一步（短期）

**真去用一周（2026-05-25 → 2026-06-01）**：
1. 监控 daily ingest cron 是否稳跑（每天 04:00 自动）
2. 监控 周一 09:00 周报是否成功推达，群内反馈如何
3. 继续日常 @bot 问退货问题——记录答歪 / 想问没工具
4. 跟 DW 同事追 `other` reason 占比 73.7% 的根因

**候选下一战场**（按价值降序，等真实需求触发）：
- **跟 DW 同事核实 `other` reason 映射** —— 数据债不修，RAG 之外的结构化分析价值持续下降
- **B2/B3 SKU 级预聚合退货率工具** —— 小切片，半天，让 LLM 不用自己跑算术
- **A1+A3 bot↔paperclip 联动** —— 让 bot 能开 issue / agent 跑完推钉钉
- **上游同步** —— 116/63 分叉，再不同步会进一步增加合并成本

---

## 📅 复盘节点

- ~~2026-05-14 一次复盘~~：跳过（被 RAG 多账号 + 分层 + cron 拉满）
- **2026-05-28 二次复盘**（3 天后）：C3 已提前做完。复盘内容改为：看 cron + 周报真实使用反馈
- **2026-06-08 三次复盘**（2 周后）：决定是否做 B2/B3 / A1+A3 / Concierge 迁移

---

## ⚠️ 风险 / 关注点

1. **数据债加剧** —— `other` 退货原因 51%→73.7%（5/7→5/25）
2. **RAG 服务单点故障** —— 非 launchd，Mac 重启即丢，cron 会 preflight skip
3. **上游同步债** —— ahead 116 / behind 63，越拖越痛
4. **LM Studio 依赖** —— ingest cron + 周报 + bot 问答全靠本地 Mac 的 LM Studio。LM Studio 挂或模型未加载 → 全链路降级
5. **tabcode/gpt-5.4 仍在用** —— 锁定风险未消除（无 prompt cache、可能改价 / 变接口）
6. **Clash + launchd NO_PROXY 坑** —— 本次踩了；任何新加的 launchd 后台 Python 调本地服务都要记得 `NO_PROXY=*`
