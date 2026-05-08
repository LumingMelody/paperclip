# EverPretty AI 系统进度快照

**日期**：2026-05-07
**状态**：MVP 已上线，等待真实使用反馈
**关联文档**：
- `docs/superpowers/plans/2026-05-07-everpretty-bot-future-roadmap.md`（38 项 backlog）
- `docs/superpowers/plans/2026-04-27-everpretty-ai-roadmap.md`（Phase 1 已交付清单）
- `everpretty_ai_company_architecture.md`（公司整体架构愿景）
- `decisions.log`（架构决策含已知债）

---

## 📍 一句话总结

**paperclip × Ever-Pretty 已经从"骨架"变成"能问退货能问销售的 BI 助手 + 自治 agent 平台"，但 80% 的 agent 还在架子上没跑起来，bot 和 paperclip agents 业务上分开。**

---

## 🟢 在跑的服务（24/7 launchd 守护）

| 服务 | 进程 | 端口 / 入口 | 用途 |
|---|---|---|---|
| `com.everpretty.dingtalk-bot` | PID 11401 | 钉钉 Stream WS | 用户问答入口 |
| `com.everpretty.paperclip-dev` | PID 15397 | http://127.0.0.1:3100 | paperclip Web UI / agent 平台 |

管理：
```bash
~/PycharmProjects/paperclip-dingtalk-bot/launchd/install.sh status|restart|logs
~/PycharmProjects/paperclip/launchd/install.sh status|restart|logs
```

---

## 🛠 工具层（21 个）

| Source | 数 | 工具 |
|---|---:|---|
| `lingxing` | 4 | factSku / factOrders / topSkus / stockoutRisk |
| `dws` | 6 | returnReasons / returnsBySku / returnDetail / refundComments / returnTrend / **skusByReason** |
| `meta` | 2 | adAccountSummary / adsetPerformance |
| `shopify` | 2 | getProduct / listProductsByCollection |
| `spapi` | 2 | getOrder / listOrdersUpdatedSince |
| `admin` | 5 | briefs.parse / costs.rollup / decisions.search / registry.list / toolCalls.search |

**关键能力突破**：
- ✅ 5 个 dws 工具拉真正的 Amazon 退货 reason code（领星 API 没暴露这个，靠公司内部 Aliyun DW）
- ✅ skusByReason 解决"按特定 reason 找 Top SKU"的真实运营问题
- ✅ refundComments 拿客户原话作 reason 验证

---

## 🤖 paperclip Agents（10 个）

| Agent | 状态 | Phase 1 跑过的 issue |
|---|---|---|
| CEO | 架在那 | — |
| CMO | 架在那 | — |
| CXOps | 跑过 | CRO-27（Anna Action Brief 自动生成）|
| DataPlatform | 跑过 | CRO-22 / 24 / 25 / 26（MCP server / golden dataset / verifier / close-loop）|
| Finance | 跑过 | CRO-21（SKU × Market 净利润）/ CRO-23（现金流预测）|
| Marketing | 架在那 | — |
| ProductSizing | 架在那 | Phase 1 计划过 SKIPPED（codex 同意） |
| Research | 架在那 | — |
| Supply | 架在那 | — |
| CTO | 架在那 | — |

**真在跑** 3/10。其余 7 个等业务派 issue 才会激活。

---

## 🟡 钉钉 Bot 能力

### 当前能答的（实测过）
- "EP-US Top 10 sku" → 销售排序
- "EP-US 库存预警" → 高速 SKU 风险
- "EP-US 过去 30 天退货原因 Top 5" → reason 分布 + 客户原话
- "EP-US 偏小退货最多的 SKU 前 10" → 按 reason 过滤 Top SKU + 占比
- "EP-US 退货周环比" → 趋势
- "EE02968 系列退货客户都说了什么" → 客户原话
- 跨天会话连续（昨天问的今天接着问）
- 关键词重置（"重置 / 清空 / 忘掉" → 清历史）

### 出色之处
- 退货专题三段式自动输出（**现状 / 主因分析 / 建议**）
- 引用客户原话作证（"Material thin / Chest is too tight"）
- LLM 自己合并主题（偏大 + 偏小 = 尺码问题占比）
- 多工具自动串联（returnReasons → refundComments → returnTrend 一次回答里 3 工具）

### 当前限制
- ❌ 不能创建 / 读 paperclip issue（业务层不联动）
- ❌ paperclip agent 跑完不能 push 到钉钉
- ❌ 不能跨渠道（只钉钉，没飞书 / Slack）
- ❌ 不会主动报告（被动等问）
- ❌ 没有 prompt cache（tabcode 网关不支持）

---

## 🔴 已知架构债（写进 decisions.log）

**Debt-1**：钉钉 bot 是平行的 mini agent 平台，不是 paperclip 的 Concierge agent。

| 维度 | 现状 |
|---|---|
| LLM 派发 | bot 自带 (tabcode/gpt-5.4)，paperclip agents 用 Claude API |
| Prompt 管理 | bot 在 Python 字符串里，paperclip agents 在 AGENTS.md |
| 会话记忆 | bot SQLite (30 天)，paperclip 用 issue / decisions |
| 工具调度 | bot pcl-tools CLI subprocess，paperclip 标准 dispatcher |

**理想架构**：bot 极薄 DingTalk 适配层，转发到 paperclip Concierge agent。

**阻碍**：paperclip server 没有同步 chat-with-agent endpoint（routes 全是 issue / approval / routine）。

**迁移成本**：3-4 天。**触发条件**：高频"bot ↔ paperclip 联动"需求 OR 多人维护双系统认知成本。

---

## 📋 Backlog（38 项候选改进，roadmap 文档里）

| 组 | 数 | 主题 |
|---|---:|---|
| TODO-A | 4 | bot ↔ paperclip 业务联动 |
| TODO-B | 5 | 退货分析能力扩展 |
| TODO-C | 6 | Agent 化扩展（Concierge / 周报 / 闭环 / 多 agent 协作）|
| TODO-D | 3 | 数据源扩展（凯帝丽莎 B2B / Reviews 扩量 / SP-API 退货）|
| TODO-E | 4 | 体验 / 性能（Claude API 切换 / MCP / catalog 缓存 / response cache）|
| TODO-F | 3 | 运维 / 可观测 |
| TODO-G | 13 | 21 工具覆盖盘点（滞销库存 / Reviews 检索 / 退货率 / 跨店 / Amazon PPC / BSR / 净利润 / FBA 仓储费 等）|

---

## 🌐 仓库

| 仓 | URL | 最新 commit |
|---|---|---|
| paperclip（fork）| https://github.com/LumingMelody/paperclip | 573d99e1 |
| 钉钉 bot | https://github.com/LumingMelody/paperclip-dingtalk-bot | 7b970a2 |

上游 `paperclipai/paperclip`：本地 ahead 23 / behind 63，暂不同步。

---

## 🧭 完成度评估

| Phase | 完成度 | 说明 |
|---|---|---|
| Phase 0 — 基建 | **100%** | 数据中台 / MCP server / launchd / 仓托管 |
| Phase 1 — 数据中台 + MVP 链路 | **95%** | 21 个工具 + Finance/CXOps/DataPlatform agents 跑通 |
| Phase 2 — 横向 agent 复制 | **25%** | 10 agent 创建，仅 3 个真用 |
| Phase 3 — 全栈 + 治理 + 闭环 | **5%** | telemetry 有了，闭环建议追踪没做 |

---

## ⏭️ 下一步（短期）

**真去用一周（2026-05-07 → 2026-05-14）**：
1. 每天发 5-10 个真实退货 / 销售 / 库存问题给钉钉 bot
2. 截图记录：答歪 / 答得意外好 / 想问但没工具 / 嫌延迟
3. 一周后对照 38 项 backlog 决定真该动哪几个

**坚守原则**：
- 没有真实使用 case 的 backlog 项 → 不动
- 同类需求出现 ≥3 次 → 才补
- reliability bug → 立即修

---

## 📅 复盘节点

- **2026-05-14**（一周后）：第一次复盘，决定 TODO-A/B/C/G 哪几项动手
- **2026-05-28**（两周后）：第二次复盘，决定 Concierge 迁移 / 定时周报 / 多 agent 协作

---

## ⚠️ 风险 / 关注点

1. `other` 退货原因占 51%（Amazon 默认）—— 需要跟 DW 同事确认是否分类映射不全
2. amazon_reviews 表只有 84 行（2026-05-06 才开始抓）—— Reviews 类工具如果做要先扩量级
3. 上游 paperclip ahead 你 63 commits，每天还在涨 —— 同步会越来越痛
4. tabcode/gpt-5.4 是第三方网关，存在锁定风险（无 prompt cache、可能改价 / 变接口）
