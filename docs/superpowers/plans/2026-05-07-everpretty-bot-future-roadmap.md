# EverPretty 钉钉 Bot + 退货 Agent 后续路线图

**日期**: 2026-05-07
**作者**: Claude (auto-loop)
**状态**: 📋 Backlog — 等真实使用反馈再决定优先级，不要盲目动手

## 当前状态 Snapshot（本 session 已交付）

- 钉钉 bot 上线，hybrid regex + LLM dispatcher (tabcode/gpt-5.4)
- 5 个 dws.* 工具进 paperclip tool-registry：returnReasons / returnsBySku / returnDetail / refundComments / returnTrend
- 退货专题 system prompt：现状/主因分析/建议三段式输出
- SQLite 持久化会话记忆（30 天 TTL）
- 3 个保险机制：reset 关键词 / 代码版本自动清理 / 失败自动清理
- launchd 化两个服务：`com.everpretty.dingtalk-bot` + `com.everpretty.paperclip-dev`
- bot 与 paperclip 共用 tool-registry / secrets / telemetry，但业务流程平行

---

## 🔴 已知架构债（先记录，不急着改）

### Debt-1: bot 是平行的 mini agent 平台

**问题**: 钉钉 bot 自带 LLM dispatcher / system prompt / 会话记忆 / 工具调度，跟
paperclip 的 agent 系统平行存在，等于在 paperclip 旁边搭了第二套 agent 平台。

**理想架构**: bot 是极薄 DingTalk 适配层，转发到 paperclip 的 Concierge agent，
所有 LLM / prompt / 记忆走 paperclip 标准。

**阻碍**: paperclip server 没有同步 chat-with-agent endpoint（全是 issue 异步驱动）。

**迁移成本**: ~3-4 天
- 1-2d: paperclip 加 chat endpoint（streaming / SSE / 会话表）
- 0.5d: 创建 Concierge agent + AGENTS.md
- 0.5d: bot 改成纯转发
- 0.5d: 删除重复状态 + 测试 + 数据迁移

**触发条件**:
- 出现需要 "bot ↔ paperclip 闭环" 的高频用户场景（如让 bot 派 issue 给 ProductSizing）
- 出现 prompt 改动需要热加载（不重启 bot）的痛点
- 团队多人维护 → 双系统认知成本不可接受

如果只是单用户问数据，**不必改**。

---

## 🟡 业务层 backlog（等真实需求驱动）

### TODO-A: bot ↔ paperclip 业务联动

| 子项 | 触发条件 | 工作量 |
|---|---|---|
| A1. bot 能创建 paperclip issue | 用户钉钉里说"派给 ProductSizing 跟进 EE02968 退货问题" | 半天 |
| A2. bot 能查 paperclip 已有 issue / decisions | 用户问"上周 ProductSizing 怎么说的" | 半天 |
| A3. paperclip agent 完成 issue → push 钉钉 | 你想要 ProductSizing 跑完主动推送结果 | 半天 |
| A4. bot 对话写入 paperclip Web UI | 想在 Web UI 看钉钉对话历史 | 1 天（依赖 Debt-1 部分迁移） |

### TODO-B: 退货分析能力扩展

| 子项 | 价值 | 工作量 |
|---|---|---|
| B1. 跨渠道退货工具（Shopify / TikTok / Dia & Co） | 全渠道退货分析，目前只覆盖 Amazon | 1-2 h |
| B2. 尺码 × 颜色多维切片（基于 dws_od_amazon_refund_rate_d 的 size/color 字段） | 答"EE02968 哪个码 × 颜色组合退货最多" | 2 h |
| B3. 接 `dws_od_amazon_refund_rate_d` 的 sku-级预聚合退货率 | 不用 LLM 自己算 returnCount/orderQty | 30 min |
| B4. 接 amazon_reviews 表（fit_status / fit_reason）做退货 reason 验证 | 双重证据：reason code + 评论文本 | 1 h |
| B5. 跨数据 join：退货 × FBA 库存 × 广告花费 | 答"退货率高 + 库存高的 SKU 该停售" | 半天 |

### TODO-C: Agent 化扩展

| 子项 | 价值 | 工作量 |
|---|---|---|
| C1. 创建 Concierge agent in paperclip（解 Debt-1） | 见上面架构债 | 3-4 天 |
| C2. 让 ProductSizing 用上 dws.* 工具（更新 AGENTS.md） | ProductSizing 输出加上退货证据 | 1 h |
| C3. 定时退货周报（paperclip routine: 每周一 09:00 拉数据写 issue） | 主动产出，不依赖人问 | 3-4 h |
| C4. 闭环建议追踪（建议被采纳后 → agent 跟踪退货率变化） | 真"agent" 而非 BI | 1-2 天 |
| C5. 多 agent 协作（退货 → listing 优化 → 上架）| 长远愿景 | 数周 |
| C6. Listing 优化 agent（消费退货 reason + 客户评论 → 给 listing 改写建议） | 链路终端价值 | 2-3 天 |

### TODO-D: 数据源扩展

| 子项 | 价值 | 工作量 |
|---|---|---|
| D1. 凯帝丽莎 B2B 数据接入 | 你公司另一条腿，目前 0 信号 | 数天（取决于他们数据形态） |
| D2. 评价分析 Agent 数据扩量（amazon_reviews 当前仅 84 行） | Phase 2 评价分析 agent 才有底气运行 | 视抓取规模而定 |
| D3. SP-API FBA Customer Returns Report 直拉（绕过领星）| 拿 buyer-seller messages 等更详细字段 | 3-5 天 |

### TODO-E: 体验 / 性能优化

| 子项 | 价值 | 工作量 | 触发条件 |
|---|---|---|---|
| E1. bot 切到 Claude API 直连（替代 tabcode）| 拿真实 prompt cache，省 ~30% input tokens | 1 h | 你嫌 LLM 调用慢 / 费钱 |
| E2. bot 走 paperclip MCP（替代 CLI subprocess） | 每次 tool call 省 200-500ms | 3-4 h | 单次问答整体 >30s 不可接受 |
| E3. Tool catalog 启动时一次性加载 + SIGHUP 重载 | 每次 dispatch 省 ~50ms | 30 min | 不痛不痒 |
| E4. 应用层 response cache | 高频重复问题省钱 | 1 h | 看真实重复率 |

### TODO-F: 运维 / 可观测

| 子项 | 价值 | 工作量 |
|---|---|---|
| F1. 统一日志查询（bot logs + paperclip logs + telemetry → 一个面板） | 排查跨服务问题 | 半天 |
| F2. bot 失败告警（连续 N 次"工具调用失败"自动通知） | 不让用户先发现 | 1 h |
| F3. 退货数据 ETL 监控（DW 表更新延迟告警） | 数据没刷新但 bot 还在答 = 误导 | 半天 |

---

## 📌 OPEN QUESTIONS（实测后再决定）

1. **真实使用频率**：你每天/每周问 bot 几次？哪类问题最频繁？
2. **答歪/答不上的 case**：截图记录，作为 prompt + 工具改进依据
3. **超出预期的 case**：哪些回答让你觉得"哇这真有用"——固化下来
4. **延迟体感**：15-30s 等待 OK 还是不能忍？决定 E1/E2 优先级
5. **主动 vs 被动**：你更需要 bot "随问随答"还是 "周一主动推送"？决定 C3 优先级
6. **协作范围**：只有你用还是同事也用？决定多用户支持优先级
7. **bot ↔ paperclip 真有需要联动吗？** 决定 TODO-A 整组优先级

---

## 决策原则

**任何 TODO 在以下条件之前不动手**：
1. 有具体真实用户 case 触发（截图 / 描述）
2. 同类需求出现 ≥3 次
3. 当前 workaround 显著低效

**例外**: 是否有显著 reliability bug（崩溃 / 数据错乱）—— 立即修，不走 TODO 流程。

---

## 复盘节点

**第一次复盘**: 2026-05-14（一周后）
- 看 bot 真实使用情况
- 决定 TODO-A/B/C 哪组先动
- 决定 Debt-1 是否迁移

**第二次复盘**: 2026-05-28（两周后）
- 看是否要做 C3（定时周报）/ C2（ProductSizing 整合）
- 看 bot 是否值得做更多

---

## 相关文档

- `docs/superpowers/plans/2026-04-27-everpretty-ai-roadmap.md` — Phase 1 已交付
- `everpretty_ai_company_architecture.md` — 整体公司架构愿景
- `paperclip-dingtalk-bot/` — bot 代码库
- `~/.claude/skills/dingtalk-stream-multiple-bot-processes-race/SKILL.md` — bot 多进程坑
- `~/.claude/skills/paperclip-dev-stale-registry-after-crash/SKILL.md` — paperclip dev 残留 pid 问题
