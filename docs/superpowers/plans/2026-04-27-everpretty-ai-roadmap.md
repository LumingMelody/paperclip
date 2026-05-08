# Ever-Pretty AI 公司架构 — 待实现 Roadmap

> 对照 `everpretty_ai_company_architecture.md` 字面 spec。当前完成度 ~30-45%,本 plan 列剩下 55-70% 的具体 task,按 ROI 排序。
>
> 每个 task = 一个 Paperclip issue,派给对应 agent,由 board(我或用户)验收。**不是代码工程 plan,是 agent 派单 plan。**

**Goal:** 把架构 spec 从 30-45% 推进到 70-80%,聚焦能给 Anna 真实业务价值的部分,跳过价值递减的部分

**Architecture:** 单 Paperclip company(`a0f62167-...`,prefix CRO),5 个现有 agent + 视需要新建 2-3 个,数据层用现有 `everypretty.v_sku_performance` / `v_sku_map` Views,新数据源按需接

**Tech Stack:** Paperclip control plane + claude_local adapter(Sonnet 4.6)+ MySQL Tencent Cloud + 已有 `/Users/melodylu/PycharmProjects/lingxing/` 领星 ETL

---

## 当前进度 Snapshot(对照 spec 各部门)

| 中心 | spec 子 agent 数 | 实际 | 完成度 |
|---|---|---|---|
| 顶层 CEO + 战略 | 2 | 0(Codex 推翻 CEO Agent) | 已 revise |
| **A. 渠道运营** | 7-9 | 0 个独立 channel agent | **5%** |
| **B. 商品** | 3 | ProductSizing 1 个(只数值层)| **30%** |
| **C. 供应链** | 3 | Supply 1 个空壳 | **10%** |
| **D. 营销** | 3 | Marketing 1 个(只 Amazon 站内广告)| **30%** |
| **E. 客户** | 2 | CXOps 1 个(客服 Copilot)| **50%** |
| **F. 财务** | 2 | 0 | **0%** |

| 共享基建 | 完成度 |
|---|---|
| 数据合同 / SQL Views | 70% |
| MCP Server | 0% |
| 审批流系统化 | 10% |

| ★ 反馈闭环 | 完成度 |
|---|---|
| 评价分析(数值 ✅ / 文本 ❌) | 35% |
| 库存预测 | 5% |
| 退货分析(数值 ✅ / 文本 ❌) | 35% |

---

## 待实现 Task 清单(按 ROI 排序)

### Task 1: 财务中心启动 — SKU × Market 净利润分析(高 ROI)

**对应 spec:** F. 财务中心 → 利润核算 Agent(SKU/渠道级)

**为什么排第一:** 数据全在(`v_sku_performance` 已有 spend/sales/return),SQL 一跑就出。EP-DE under-invested 洞察(CRO-20)需要净利润维度才能确认 ROI。当前 0% → 推进到 30-40%。

**Files / Agents:**
- 新建 agent: `Finance`(role=`cfo`,icon=`gem`)
- AGENTS.md path: `~/.paperclip/.../agents/<finance-id>/instructions/AGENTS.md`
- Issue 派给 Finance,project: `Ever-Pretty AI Foundation`

**Steps:**

- [x] **Step 1.1:** 创建 Finance agent (id `ffbebaee-4f54-4712-8a7b-4a06ce70d674`)
  ```bash
  curl -X POST http://127.0.0.1:3100/api/companies/a0f62167-.../agents \
    -d '{"name":"Finance","role":"cfo","icon":"gem","title":"财务中心 / Profit & Cash Flow Analyst",
         "capabilities":"SKU × market 净利润核算(扣广告+退货+物流);跨市场 ROI 对比;现金流预测(领星订单+在途);汇率影响 USD/EUR/GBP;Phase 2 接入 P&L 完整链路",
         "adapterType":"claude_local","adapterConfig":{"model":"claude-sonnet-4-6","dangerouslySkipPermissions":true}}'
  ```
- [x] **Step 1.2:** 写 AGENTS.md(参考其他 agent 风格,强调"不要计算未来现金流,只看历史已发生")
- [x] **Step 1.3:** 创建 issue **CRO-21** 派 Finance,scope:
  - 核心问题:**EP-DE 真的该追投广告吗?算上汇率/退货/广告成本后净利润是否仍优于 EP-US?**
  - Top 100 SKU(EP-US)净利润排序:`gmv - ad_spend - returns_loss - estimated_cogs(40% gmv 假设)`
  - 跨市场净 ROI 对比:US/UK/DE 同款式 net margin
  - 输出 `docs/finance/sku-net-profit.md` + `data/finance-queries.sql`
- [x] **Step 1.4:** 触发 wake(自动 by assignment) — Finance 自动 wake,run started
- [x] **Step 1.5:** Verify(独立 SQL + 文件落盘)+ mark done — net margins 32.7/48.5/44.2 = 32.3/48.2/43.9 ✅

**预计:** 1-2 wake,~30 分钟,$0 token(local model)

---

### Task 2: MCP Server 极薄版本 — 包 SQL Views 给外部 AI 用(中 ROI)

**对应 spec:** 共享基础设施 → MCP Server / Phase 0 数据中台

**为什么排第二:** Codex 同意"极薄版本"。让 Anna 在 Cursor / Claude Code / 飞书机器人能直接问 "EE01961 的 EP-DE 退货率是多少",不用每次写 SQL。共享基建从 70% → 85%。

**Files / Agents:**
- DataPlatform(已有,id `8adc4aed-...`)负责
- MCP server 代码:`mcp-servers/everpretty-views/`(在 project workspace `_default/`)
- 用 `mcp-builder` skill(已 available)

**Steps:**

- [x] **Step 2.1:** 创建 issue **CRO-22** 派 DataPlatform,scope:
  - 用 Python FastMCP 框架(轻量),工具列表:
    - `query_sku_performance(seller_sku, sid?, start_date?, end_date?)` — 投影 v_sku_performance
    - `get_sku_kb(seller_sku)` — 读 cx-knowledge/sku_kb.json
    - `compare_markets(seller_sku, sids[])` — 跨市场对比
    - `get_top_skus(sid, metric, limit)` — Top N 排序
  - **只读,不写**(Phase 2 才上写接口)
  - 写 `mcp-servers/everpretty-views/server.py` + `README.md` + 启动命令
  - **不要新建 ETL / 不要复制数据,只读 v_sku_performance**
- [x] **Step 2.2:** wake DataPlatform 跑 — 自动 wake by assignment
- [x] **Step 2.3:** Verify:用 `mcp inspect` 或 curl 调用 server 测一个 tool 真返回数据 — 22 tests passed in 26.83s ✅
- [x] **Step 2.4:** Mark done + 在 README 里说明 Anna 怎么在 Claude Code / Cursor 配置使用

**预计:** 2-3 wake,~1 小时,$0(local)

---

### Task 3: 评论文本分析层 — 验证"全系列偏小"假设(中-高 ROI)

**对应 spec:** B. 商品 → ★ 评价分析 Agent(从评论里挖尺码/质量/色差反馈)

**为什么排第三:** 当前 ProductSizing 给的是 `[INFERRED, H]` 数值结论。要升 `[VERIFIED]` 级,必须接评论文本。用户已有 `amazon-mobile-review-scraping` skill。文本层从 0% → 50%。

**Files / Agents:**
- ProductSizing(已有,id `af07531d-...`)负责
- 装 `amazon-mobile-review-scraping` skill 给 ProductSizing
- 输出在 `docs/diagnosis/review-text-analysis/`

**Steps:**

- [x] **Step 3.1:** 装 skill 给 ProductSizing: ~~SKIPPED~~ (Codex 同意,Phase 2 backlog)
  ```bash
  curl -X POST http://127.0.0.1:3100/api/agents/<productsizing-id>/skills/sync \
    -d '{"skillNames":["amazon-mobile-review-scraping"]}'
  ```
- [x] **Step 3.2:** 创建 issue **CRO-23** 派 ProductSizing,scope: ~~SKIPPED~~
  - 用 amazon-mobile-review-scraping skill 抓 EE01961 / EE02960 / ES01068 3 个 P0 款式的评论(各 100-200 条,带 Size/Color/Height/Weight)
  - 用本地 Gemma 4 31B(MLX)或 Claude Haiku 做尺码/版型/面料 5 因子分析
  - 验证 CRO-16 的"全系列偏小"假设是 verified 还是 falsified
  - 输出 `docs/diagnosis/review-text-analysis/<style>.md` 每款一份 + 总结报告
- [x] **Step 3.3:** wake + verify(评论真抓到 + 分析有引用具体评论 ID) ~~SKIPPED~~
- [x] **Step 3.4:** 如果文本验证 confirms `[VERIFIED]`:更新 sku_kb.json confidence 字段 ~~SKIPPED~~

**预计:** 2-4 wake,~2-3 小时(评论抓取受 Amazon rate limit),token 消耗会有($5-20 估)

---

### Task 4: 财务中心扩展 — 现金流预测 Agent(中 ROI,Task 1 后续)

**对应 spec:** F. 财务中心 → 现金流 / 汇率 Agent

**为什么:** Task 1 出净利润后,Anna 会问"那现金流呢?在途 + 应收 + 货款占用多少?"这是自然延伸。

**Files / Agents:**
- Finance(Task 1 创建)继续用
- 数据源:`everypretty.lx_*` + 凯帝丽莎在途库存(若可拿)

**Steps:**

- [x] **Step 4.1:** 看 lx_* 表是否有在途库存数据 — **无 inventory 表**(只有 product_msku/parent_asin/sku_map),降级到只算应收 + 工厂预付款假设
- [x] **Step 4.2:** 创建 issue **CRO-23** 派 Finance(实际编号 CRO-23,因 Task 3 skip)
  - 30/60/90 天现金流预测(基于历史订单速率 × 平均回款周期)
  - 跨币种归一化(USD/EUR/GBP → CNY,用近 30 天平均汇率)
  - 工厂预付款占用估算(假设 40% gmv,可调)
- [x] **Step 4.3:** wake + verify — working capital ~94% 月净利,工厂账期问题确认

**预计:** 1-2 wake,~30-45 分钟

---

### Task 5: 库存预测启动 — Supply 真干活(低-中 ROI)

**对应 spec:** C. 供应链 → ★ 库存预测 Agent

**为什么排低:** Codex 评审说"不在主痛点"。但 EP-UK / EP-DE 退货率低,实际订单大概率 under-served(spend 低 = 没投够广告 = 单量低 = 库存预测窗口短)。Phase 2 该启动。

**前置:** 要 12 月历史回灌(rebuild_asin_daily.py 跑 3-5h)。

**Files / Agents:**
- Supply(已有,id `960b5f82-...`)
- 触发 lingxing 项目的 `rebuild_asin_daily.py`

**Steps:**

- [x] **Step 5.1:** **board 决策**:要不要回灌? ~~SKIPPED~~ (board 决策:不启动,等 Task 4 现金流出结果再评估,见 decisions.log)
- [x] **Step 5.2:** 创建 issue **CRO-25**(回灌)派 DataPlatform,scope: ~~SKIPPED~~
  - `cd /Users/melodylu/PycharmProjects/lingxing && nohup .venv/bin/python rebuild_asin_daily.py > rebuild.log 2>&1 &`
  - 监控直到完成,在 issue 评论里 update 进度
  - 完成后改 issue 为 done
- [x] **Step 5.3:** 创建 issue **CRO-26**(预测)派 Supply,scope: ~~SKIPPED~~
  - 5 个季节性脉冲(Prom/Wedding/Homecoming/BFCM/Graduation)分别建模
  - Top 100 SKU 30/60/90 天补货建议(尺码 mix + 路由 FBA US-East / West / 海外仓 / 直邮)
  - 输出 `docs/supply/replenishment-plan.md`
- [x] **Step 5.4:** Verify + mark done ~~SKIPPED~~

**预计:** 回灌 3-5h(自动) + 建模 2-3 wake(~1 小时)

---

### Task 6: 渠道运营独立站 / B2B(暂时跳过)

**对应 spec:** A. 渠道运营 → 独立站 Agent + B2B Agent

**为什么跳过:** 数据未就绪(领星无 shopify 接入,凯帝丽莎 e4wholesale 数据未确认)。需要先做数据接入,再考虑 agent。

**条件触发:** 用户提供 shopify API 凭证 / 凯帝丽莎 OMS 数据库连接 → 启动

---

### Task 7: 营销中心扩展 — Google/Meta/TikTok Ads(暂时跳过)

**对应 spec:** D. 营销中心 → 站外广告 Agent

**为什么跳过:** 用户已有 `meta-ads-reporting` / `microsoft-ads-reporting` / `criteo-reporting` skills 但都是 reporting only。要 build agent 还需:1) 装 skill 给 Marketing 2) 数据回灌 3) 跨平台归因模型(复杂)。建议 Phase 3 启动。

**条件触发:** 用户决定要做跨平台广告归因 → 启动

---

## Phase 完成度推进对照

| Phase | 当前 | 完成 Task 1 后 | 完成 Task 1+2 后 | 完成 1+2+3 后 |
|---|---|---|---|---|
| Phase 0 | 25% | 25% | 60%(MCP done) | 60% |
| Phase 1 | 60% | 70%(Finance + 净利润) | 70% | 85%(评论文本)|
| Phase 2 | 10% | 10% | 10% | 10% |
| Phase 3 | 20% | 35%(Finance done) | 40%(MCP)| 40% |
| **整体** | **30-45%** | **40-50%** | **50-60%** | **60-70%** |

---

## 验收标准(每个 Task 通用)

每个 task 完成定义:
1. ✅ 文件真实落盘(verify on disk,不信 self-report)
2. ✅ 关键数字 board 独立 SQL verify(不信 agent 报告)
3. ✅ 报告含 `[ASSUMPTION/INFERRED, L/M/H]` confidence
4. ✅ 数据局限性声明明确
5. ✅ 可重现 SQL 落盘
6. ✅ Issue mark done by board(不是 agent self-mark)

---

## 不在本 plan 范围

- ❌ Anna ops 团队的工作(改 listing / 改广告出价 / 工厂下单)
- ❌ Phase 2 backlog 启动(`CRO-19` 等 listing 修订效果)
- ❌ 视觉 Agent / 选品 Agent / 红人 Agent / 内容 Agent / 物流 Agent / 工厂协同 Agent(视觉 / 内容生成不是 SQL+text 能搞定的,Phase 3+)
- ❌ 审批流系统化(目前用 board PATCH 充当,Phase 3 治理才上)
- ❌ Routine 启用(用户明确不要自动烧 token)
- ❌ MCP Server 写接口(Phase 2 才上)

---

## 执行选择

**推荐顺序:** Task 1 → Task 2 → Task 3 → Task 4 → 评估 Task 5 是否启动 → 停

**也可以并行:** Task 1 + Task 3 真正并行(Finance + ProductSizing 不同 agent),但 Task 3 token 成本不为 0,慎重

**或停在这里:** 当前 30-45% 已经产生百万级业务价值(EP-US listing 修订 + EP-DE 追投建议),继续做边际价值递减,可等 Anna 真做完 listing 修订后再启 Phase 2

---

## 时间 / 成本估算

| Task | 时间 | Token | 风险 |
|---|---|---|---|
| Task 1(Finance 净利润) | 30 分钟 | $0 | 低 |
| Task 2(MCP server) | 1 小时 | $0 | 低 |
| Task 3(评论文本) | 2-3 小时 | $5-20 | 中(Amazon rate limit + 抓取被封) |
| Task 4(现金流) | 30-45 分钟 | $0 | 低 |
| Task 5(库存预测) | 4-6 小时 | $0-5 | 中-高(领星 API rate limit + 长 tail) |

**Task 1+2+3+4 总和:** ~5 小时 + $5-20 token,把整体完成度推到 60-70%

---

## Phase 1.6: Eval / Benchmark 基础设施(autoloop round 2,A → B → E sequential)

**Trigger**:读完《Agent 时代,工程师最值钱的能力是说"不"》+ Codex 评审。当前 6 agent + 9 issue 全靠 board 手动 verify,DataPlatform 已 hallucinate 2 次,无 systematic distrust 机制。

**Codex 4 个 push back 已并入**(见 decisions.log)。

### Task 6.A: Golden dataset minimal(1 天)

**Files / Agents:**
- DataPlatform 兼任(数据治理边界)
- 输出:`benchmarks/golden.json` + `benchmarks/README.md`

**Steps:**

- [x] **Step 6A.1:** 创建 issue **CRO-24** 派 DataPlatform,scope:固化 9 个已 verified 关键数字 — auto-wake
- [x] **Step 6A.2:** wake + verify — golden.json 9 metrics, EP-US return 19.56 SQL re-verified ✅
- [x] **Step 6A.3:** mark done

### Task 6.B: Issue 状态流转 verifier(2-3 天)

**Files / Agents:**
- DataPlatform
- 输出:`scripts/eval/verifier.ts` + `scripts/eval/cron-backstop.sh`

**Steps:**

- [x] **Step 6B.1:** 创建 issue **CRO-25** 派 DataPlatform — auto-wake
  - 声明产物文件真存在(防 fantasy approval)
  - 关键数字 diff against golden.json,差距 >5% 自动 reject
  - 必要日志(SQL queries 落盘等)
  - **接 paperclip API issue PATCH 而不是评论**(Codex push back)
- [x] **Step 6B.2:** cron-backstop done(daily 09:00 CST,需 Anna `crontab -e` 启用)
- [x] **Step 6B.3:** wake + verify + 自测 — 17/17 assertions passed (board re-ran tsx test-verifier.ts)
- [x] **Step 6B.4:** mark done

### Task 6.E: Decision close-loop schedule(分层)

**Files / Agents:**
- DataPlatform
- 输出:`scripts/eval/close-loop-ads.sh`(1-2w)+ `scripts/eval/close-loop-returns.sh`(4-6w)

**Steps:**

- [x] **Step 6E.1:** 创建 issue **CRO-26** 派 DataPlatform — auto-wake
  - 广告轻量复查(1-2 周后):重跑 CRO-20 关键数字,跟 golden 比较
  - 退货/利润正式 close-loop(4-6 周):重跑 CRO-16/18/21,跟 golden 比较
  - 输出 close-loop 周报到 `docs/eval/`
  - **不做业务裁决**(只 surface 变化,Anna 决策)
- [x] **Step 6E.2:** wake + verify — board 跑 DRY_RUN=true bash close-loop-ads.sh,2 metrics PASS (19.28/5.19)
- [x] **Step 6E.3:** mark done


---

## Phase 1.7: Anna Action Brief(autoloop round 3)

**Trigger**:Codex 评审反对"现在停手"— "把交付停在 Anna 无法消费的形态上"。9 个 issue 产出 30+ 个 markdown / CSV / SQL 散落在 `_default/docs/`,Anna 不是 Claude Code 用户。

**Codex 3 个 push back 已并入**:
1. 派 **CXOps** 不新建 Communicator(架构膨胀)
2. **2 页硬上限**(5 页 = 没写)
3. **P1 = Top 3 actions(ROI/owner/deadline/risk)**;P2 = 15 SKU 砍清单 + close-loop trigger

### Task 7: Anna Action Brief(20-30 min)

- [x] **Step 7.1:** 创建 issue **CRO-27** 派 CXOps — auto-wake
- [x] **Step 7.2:** wake + verify — 394 词 / 5 字段全填 / 15 SKU 清单 / close-loop trigger 命令真指向存在的 .sh ✅
- [x] **Step 7.3:** mark done

