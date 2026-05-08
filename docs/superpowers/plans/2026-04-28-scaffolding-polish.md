# Ever-Pretty AI Scaffolding Polish — autoloop-able Plan

> **For autoloop:** Stop hook scans `- [ ]` checkboxes. Each task is **either a board self-edit** (Edit/Write/Bash) **or a paperclip issue派 agent**. 不依赖 Anna 输入 / 外部数据。
>
> **Save plan checkpoint:** `~/PycharmProjects/paperclip/docs/superpowers/plans/2026-04-28-scaffolding-polish.md`
> **Decisions log:** `~/PycharmProjects/paperclip/decisions.log`

**Goal:** 把 Ever-Pretty AI Foundation 项目从 80-90% 推到 90-95%,补完所有不依赖 Anna / 外部数据的脚手架工作

**Architecture:** 10 个独立 task,大多数是 board 直接 edit/Write,少数派 agent。所有 task 通过现有 verifier(`scripts/eval/verifier.ts`)+ close-loop(`scripts/eval/close-loop-*.sh`)兜底验证。

**Tech Stack:** Paperclip API + Edit/Write tool + Bash + tsx + node mysql2 + 已有 6 个 agent

---

## 当前现状(plan 起点)

- 17 个 issue done(CRO-14 ~ CRO-31)
- 6 active agent + 4 paused agent
- $0 spend / 全本地 model + 已有数据
- golden.json 9 metrics + verifier 17 tests + close-loop 分层
- Anna brief V1(没含 Mermaid)
- `_default/README.md` + `CLAUDE.md` 已写

## 10 个待完成 task(按依赖排序)

---

### Task 1: Anna Brief V2 — 加 Mermaid 完整链路

**Why**: V1 brief 只 Top 3,漏了 Mermaid 测试($16.5K 完整链路 ready)。Anna 看 V1 拍板时会漏。

**Files:**
- Create: `_default/docs/anna-brief/2026-04-29-action-brief-v2.md`
- Reference: CRO-30 (Mermaid 营销决策) + CRO-31 (Mermaid 库存测算)

**Steps:**

- [x] **Step 1.1**: 创建 issue **CRO-32** 派 CXOps,scope:更新 brief 加第 4 条 action(Mermaid):
  - 测试预算 $800 广告 + $15,330 COGS = $16,530 总投入
  - 海运 6/12-6/28 上架 vs 空运 5/20-5/31 (+$1.2-2K)
  - 4 成功阈值 + 4 止损条件(从 CRO-30 引用)
  - AL20 单 SKU 14.3% 退货预警(从 CRO-31 引用)
  - 2 页硬上限不变,V2 是 V1 + 新增第 4 action(可压缩 V1 内容)

- [x] **Step 1.2**: wake CXOps + verify(brief V2 真存在,4 actions 5 字段全填,word count <800)
  - Verify: `wc -w _default/docs/anna-brief/2026-04-29-action-brief-v2.md` → 690 ✅
  - Verify: `grep -c "Mermaid" _default/docs/anna-brief/2026-04-29-action-brief-v2.md` → 3 ✅
  - Note: CXOps 写错路径 (改了 V1 路径而非新建 V2),board manual fix 把内容 cp 到 V2 路径 + 恢复 V1 原版

- [x] **Step 1.3**: PATCH CRO-32 status `done` + comment with verification evidence

---

### Task 2: CXOps 模型切到 Haiku 4.5(成本优化)

**Why**: CXOps 客服 Copilot 任务结构化 + 短文本生成,Haiku 4.5 ($1/$5 per MTok) 比 Sonnet 4.6 ($3/$15) 便宜 5x,效果差异小

**Files:**
- Modify: paperclip API agent record (`PATCH /api/agents/<cxops-id>`)

**Steps:**

- [x] **Step 2.1**: PATCH CXOps adapterConfig.model:
  ```bash
  curl -s -X PATCH "http://127.0.0.1:3100/api/agents/7f619fcd-fd0b-446d-a8af-5a50cc4cf828" \
    -H "Content-Type: application/json" \
    -d '{"adapterConfig":{"model":"claude-haiku-4-5","graceSec":15,"timeoutSec":0,"maxTurnsPerRun":1000,"dangerouslySkipPermissions":true,"instructionsBundleMode":"managed","instructionsEntryFile":"AGENTS.md"}}'
  ```

- [x] **Step 2.2**: Verify model 真切了:
  ```bash
  curl -s "http://127.0.0.1:3100/api/agents/7f619fcd-fd0b-446d-a8af-5a50cc4cf828" | python3 -c "import json,sys; d=json.load(sys.stdin); m=d['adapterConfig']['model']; print('model='+m); assert m=='claude-haiku-4-5', f'expected haiku-4-5, got {m}'"
  ```

- [x] **Step 2.3**: Update CXOps AGENTS.md metadata header `Model:` 字段为 haiku-4-5,decision log 记录决策

---

### Task 3: Verifier 加 confidence 标注必填 check

**Why**: 当前 verifier 只查文件存在/行数/golden diff/deliverables/状态。但 agent 报告里数字必须带 `[INFERRED, M]` / `[ASSUMPTION]` / `[VERIFIED]` confidence 标记 — 防止裸数字被当确定结论。

**Files:**
- Modify: `_default/scripts/eval/verifier.ts` (add new check function)
- Modify: `_default/scripts/eval/test-verifier.ts` (add 2 new test cases)

**Steps:**

- [x] **Step 3.1**: 创建 issue **CRO-33** 派 DataPlatform,scope:在 `verifier.ts` 加 `checkConfidenceAnnotations` 函数:
  - parse 评论 body,grep 数字 pattern(数字 + %, $X, 件,etc)
  - 对每个数字,window 30 chars 内必须有 `[INFERRED]` / `[ASSUMPTION]` / `[VERIFIED]` 中至少一个
  - 没标 → WARN(不 FAIL,因为部分数字是 baseline 引用不需要标)
  - 输出包含 `unannotated_numbers` 列表
  - test-verifier.ts 加 2 新测试:
    - Test A: comment "退货率 19.56% [INFERRED, H]" → PASS
    - Test B: comment "退货率 19.56% 是真的" → WARN (no annotation)

- [x] **Step 3.2**: wake DataPlatform + verify
  - 验证: `cd _default/scripts/eval && tsx test-verifier.ts` → 19/19 PASS ✅
  - 验证: verifyIssue('CRO-32') → unannotated_numbers 3 entries, confidence_check_status=WARN ✅

- [x] **Step 3.3**: PATCH CRO-33 status done + commit evidence(comment 已加 board verification)

---

### Task 4: Verifier 加 citation 完整性 check

**Why**: 数字必须有 `source_query` 或 `issue ref`(如 `CRO-21`)— 否则可能是 hallucination

**Files:**
- Modify: `_default/scripts/eval/verifier.ts`
- Modify: `_default/scripts/eval/test-verifier.ts`

**Steps:**

- [x] **Step 4.1**: 创建 issue **CRO-34** 派 DataPlatform,scope:在 verifier.ts 加 `checkCitations` 函数:
  - 对每个数字 window 60 chars,必须含至少一个:`CRO-\d+` issue ref / `\.sql` / `\.csv` / `\.json` / "from " / "see "
  - 没 citation → WARN
  - test-verifier.ts 加 2 新测试

- [x] **Step 4.2**: wake + verify(test-verifier.ts 21/21 PASS ✅,verifyIssue('CRO-32') 含 uncited_numbers field ✅)

- [x] **Step 4.3**: PATCH CRO-34 done + commit evidence(comment 已加 board verification)

---

### Task 5: golden.json 扩展 — 加 6 个 Shopify EP-US baseline metric

**Why**: Phase 2 接入了 Shopify 数据但 golden 没扩,close-loop 没法 cover Shopify 维度。

**Files:**
- Modify: `_default/benchmarks/golden.json` (add 6 metrics)
- Modify: `_default/benchmarks/README.md` (update metric table)

**Steps:**

- [x] **Step 5.1**: 创建 issue **CRO-35** 派 DataPlatform,scope:加 6 个 Shopify metric 到 golden.json:
  - `ep_us_shopify_monthly_orders` = 11446 (CRO-28)
  - `ep_us_shopify_monthly_gmv_usd` = 实测 SQL 计算
  - `ep_us_shopify_overall_refund_rate_pct` = (refunds total / gross sales total) × 100,from CRO-29 reconcile
  - `ep_us_shopify_top_sku_units_ys00000` = 8944 (赠品/配件)
  - `mg02468_shopify_monthly_units` = 408 (CRO-31)
  - `mg02468_shopify_monthly_gmv_usd` = 26528 (CRO-30)
  - 每个 metric 含:value / unit / source_issue / source_query 或 file ref / verified_at / tolerance_pct
  - 跑独立 SQL/JSON 计算 verify 数字 ≈ 报告值(<1% 差异)

- [x] **Step 5.2**: wake + verify
  - 验证: `len(metrics) = 15` ✅(原 9 + 6 new Shopify P&L)
  - 验证: close-loop-returns.sh 当前 hardcode Amazon metrics,不 pickup → 5.3 note for Phase 2.5 backlog
  - ⚠️ Spec deviation: DataPlatform delivered P&L metrics 替代规格要求的 orders/SKU-specific metrics(comment 1 self-acknowledged)。Board ACCEPT 因为 delivered 对 close-loop 更有用,但派单纪律待重申。

- [x] **Step 5.3**: PATCH CRO-35 done + (如需要)note close-loop scripts 后续要扩
  - Phase 2.5 backlog noted in CRO-35 comment(close-loop-returns.sh 扩 Shopify 维度时一并加 Mermaid-specific metric)

---

### Task 6: ADR 0004-0007 增加(架构决策持久化)

**Why**: 我们做了大量决策(Shopify 接入 / fail-loud 哲学 / 6 agent 边界 / Codex 评审 pattern)但只在 decisions.log 里 freeform。ADR 让接手人能 audit 每个决策的 Context / Decision / Consequences。

**Files:**
- Create: `_default/docs/adr/0004-shopify-integration.md`
- Create: `_default/docs/adr/0005-fail-loud-principle.md`
- Create: `_default/docs/adr/0006-six-agent-role-boundaries.md`
- Create: `_default/docs/adr/0007-codex-closure-pattern.md`

**Steps:**

- [x] **Step 6.1**: board 直接 Write `0004-shopify-integration.md`(Michael Nygard 模板:Status / Context / Decision / Consequences),内容:
  - Context: CRO-28 发现 Shopify EP-US 跟 Amazon SKU 不重叠
  - Decision: Shopify 数据接 paperclip workspace JSON,**不**落 paperclip MySQL(避免污染 lx_* 命名)。SQL Server T_shopify_sales_daily 是 lingxing 项目独立,不集成。
  - Consequences: 跨渠道 SQL JOIN 不可,但 schema 隔离干净。Phase 3 真要 cross-channel ETL 时再 promote 到 MySQL。

- [x] **Step 6.2**: Write `0005-fail-loud-principle.md`:
  - Context: SKU mapping 覆盖率 20% < 70% 阈值(CRO-28),Shopify→Amazon 推算精度差
  - Decision: 任何 mapping/匹配率 <70% → 报告头部明确写"数据不足,不支持决策修订",不强行给结论
  - Consequences: 比 silent failure 好,Anna 看到 fail-loud 信号会找其他证据

- [x] **Step 6.3**: Write `0006-six-agent-role-boundaries.md`:
  - 列 6 active agent + 4 paused 各自的 strict scope + 不做的事(避免架构膨胀)
  - 决策:不新建 Communicator / EvalGuardian / PM agent,职责由现有 agent 兼任

- [x] **Step 6.4**: Write `0007-codex-closure-pattern.md`:
  - Context: 我作为 Claude 容易陷入 confirmation bias / scope creep
  - Decision: 任何 phase 启动前用 `codex exec` 做 1 轮独立评审,push back 必须 inline 到 issue spec
  - Consequences: 慢 30s,但每次至少 catch 1-2 个 push back(Mermaid scope 不扩 / Marketing 不 ProductSizing / fail-loud 阈值 等)

---

### Task 7: Phase 1.6.D — Cost Benchmark

**Why**: 当前 spend $0(本地 model),但下次真实 API model 跑起来时无 baseline。每个 issue 完成时记 wall-clock + token spend → 月度 baseline + 3σ 异常告警。

**Files:**
- Create: `_default/scripts/eval/cost-benchmark.ts`
- Create: `_default/docs/eval/cost-baseline.md`

**Steps:**

- [x] **Step 7.1**: 创建 issue **CRO-36** 派 DataPlatform,scope:写 `cost-benchmark.ts`:
  - 通过 paperclip API 拉所有 issue 的 `startedAt` / `completedAt` / linked runs 的 `usageJson`
  - 聚合每个 agent / 每个 phase 的 wall-clock + token spend
  - 输出 `docs/eval/cost-baseline.md`(月度 baseline)
  - 当前 spend $0 → baseline = $0,但记录 wall-clock 中位数(给 Phase 3 真烧钱时对比)

- [x] **Step 7.2**: wake + verify
  - 验证: cost-baseline.md 真存在(1.7KB)+ 含 7 agent wall-clock median ✅
  - 验证: usage_data 字段 fail-loud banner(NOT AVAILABLE,$0 / 本地 model)— 符合 spec ✅

- [x] **Step 7.3**: PATCH CRO-36 done + commit evidence(comment 已加 board verification)

---

### Task 8: Health Check Script(一键状态查)

**Why**: 当前 server / DB / 6 agent / MCP server / golden 各种状态散落,接手人查全状态要 5+ 个命令。

**Files:**
- Create: `_default/scripts/health-check.sh`

**Steps:**

- [x] **Step 8.1**: board 直接 Write `health-check.sh`,内容:
  - paperclip server health: `curl http://127.0.0.1:3100/api/health`
  - MySQL connectivity: `node -e "..."` 测 v_sku_performance 行数
  - 6 agent 状态: `curl /api/companies/.../agents` parse + 列表显示
  - active issues: `curl /api/issues?status=todo,in_progress,blocked`
  - golden.json valid: `jq '.metric_count' benchmarks/golden.json`
  - close-loop scripts executable: `[ -x scripts/eval/close-loop-ads.sh ]`
  - MCP server can start: `cd mcp-servers/everpretty-views && python -c "import server"`
  - 输出 ASCII 状态表

- [x] **Step 8.2**: chmod +x 并跑一次 verify 全 PASS:
  ```bash
  chmod +x _default/scripts/health-check.sh
  bash _default/scripts/health-check.sh
  ```
  Expected: 全部 ✅,无 ❌

- [x] **Step 8.3**: Update `_default/README.md`,在第 4 节"关键命令"加 health-check.sh 引用

---

### Task 9: Inventory Archive 策略

**Why**: 11K orders JSON 占 203MB 在 _default/docs/shopify-vs-amazon/data/。每月再跑会爆盘。

**Files:**
- Create: `_default/scripts/archive-old-data.sh`
- Create: `_default/data-archive/.gitkeep`(目录占位)

**Steps:**

- [x] **Step 9.1**: board 直接 Write `archive-old-data.sh`:
  - 找 `docs/*/data/*.json` 大于 50MB + mtime > 30 天的文件
  - gzip 后 mv 到 `_default/data-archive/<year-month>/`
  - 列表显示 archived files + saved disk space

- [x] **Step 9.2**: dry-run 跑一次:`DRY_RUN=true bash archive-old-data.sh`,verify 列出当前 ep-us-shopify-orders-2026-04.json (194MB) 但不真 archive(0 天 < 30 天) ✅

- [x] **Step 9.3**: 加到 `_default/CLAUDE.md` 第 3 节"Server / 后台 task" mention archive 策略

---

### Task 10: Decision Log 结构化 — JSONL format

**Why**: 当前 `~/PycharmProjects/paperclip/decisions.log` 是 freeform plain text,verifier 没法 parse。改成 JSONL 给后续 verifier 自动 lookup。

**Files:**
- Create: `~/PycharmProjects/paperclip/decisions.jsonl`(structured)
- Keep: `~/PycharmProjects/paperclip/decisions.log`(human-readable,append both)
- Create: `_default/scripts/append-decision.sh` (helper)

**Steps:**

- [x] **Step 10.1**: board 直接 Write `append-decision.sh`:
  ```bash
  #!/bin/bash
  # Usage: bash append-decision.sh "<one-line summary>" "<reason>" [related_issues]
  SUMMARY="$1"; REASON="$2"; ISSUES="${3:-}"
  TS=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$TS] $SUMMARY — $REASON" >> ~/PycharmProjects/paperclip/decisions.log
  python3 -c "
  import json,sys,os
  d={'ts':'$TS','summary':'''$SUMMARY''','reason':'''$REASON''','issues':'''$ISSUES'''.split(',') if '''$ISSUES''' else []}
  with open(os.path.expanduser('~/PycharmProjects/paperclip/decisions.jsonl'),'a') as f:
      f.write(json.dumps(d,ensure_ascii=False)+'\n')
  "
  ```

- [x] **Step 10.2**: chmod +x + 跑一次 sanity check:
  ```bash
  bash _default/scripts/append-decision.sh "Test decision" "Plan task 10 self-test" "CRO-test"
  tail -1 ~/PycharmProjects/paperclip/decisions.jsonl | jq .
  ```
  Expected: 输出有效 JSON 行

- [x] **Step 10.3**: Backfill 当前 decisions.log 关键 entries 到 decisions.jsonl(21 个 entries 迁移 ✅,jsonl 总 21 行)
  ```bash
  python3 <<'PY'
  import json, re, os
  log = open(os.path.expanduser('~/PycharmProjects/paperclip/decisions.log')).read()
  entries = re.findall(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.+)', log)
  with open(os.path.expanduser('~/PycharmProjects/paperclip/decisions.jsonl'), 'a') as f:
      for ts, body in entries:
          f.write(json.dumps({'ts': ts, 'summary': body[:120], 'body': body, 'issues': []}, ensure_ascii=False) + '\n')
  print(f'backfilled {len(entries)} entries')
  PY
  ```

---

## Self-Review

**Spec coverage**:
- ✅ Task 1: Anna brief V2(Mermaid)
- ✅ Task 2: CXOps Haiku 4.5
- ✅ Task 3: verifier confidence check
- ✅ Task 4: verifier citation check
- ✅ Task 5: golden.json Shopify metrics
- ✅ Task 6: ADR 0004-0007
- ✅ Task 7: cost benchmark
- ✅ Task 8: health-check.sh
- ✅ Task 9: archive 策略
- ✅ Task 10: decisions.jsonl

**Placeholder scan**: 无 TBD / TODO / 模糊语句

**Type consistency**: paperclip API endpoint 一致(`/api/agents/<id>`, `/api/issues/<id>`, etc),所有文件路径绝对路径

**No external blockers**: 无 task 依赖 Anna 输入 / 外部数据接入 / 工厂数据 / 实时 API

**Token budget**: 全本地 model + 已有数据,预期 $0-5 spend 总计

---

## Execution

**autoloop-able**: 是。每个 task step 是 `- [ ]` checkbox,stop hook 会自动推进。

**Sequential vs parallel**: 大部分 task 独立,可并行。但建议:
- Task 1-5 sequential(每个会派 agent,顺序避免 agent 冲突)
- Task 6-10 board 自己做,无 agent run 冲突,可任意顺序

**预估时间**: 全 10 个 task,~2-3 小时(每个 15-20 min,含 agent run + verify)

**预估 token**: $0-5(全本地 model + Codex 评审已 closure,不再 burn)

**触发条件**: 用户 `bash autoloop-start` 或手动 `touch .claude/autoloop-active`

---

## After This Plan

Plan 全部 done 后,Ever-Pretty AI Foundation 项目从 80-90% → **95%+**。剩余 5-10% 是真依赖 Anna 输入 / 外部数据(独立 backlog,不在本 plan):

- Anna 改完 listing 4 周后跑 close-loop-returns.sh
- 真实 COGS / 工厂账期 / SQL Server VPN 接入
- 评论文本 API(Phase 2.x backlog)
- 跨平台广告归因(meta/criteo skill 装载)
- 12 月 lingxing 历史回灌

这些等用户给 unblock 信号再启。

---

## Out of Scope(明确不做)

- ❌ 真启 cron(用户 explicit 不要)
- ❌ Phase 3 dashboard / UI
- ❌ 12 月 lingxing 回灌
- ❌ 评论文本接入(Phase 2.x backlog)
- ❌ 跨平台广告(skill 装载留下次)
- ❌ 真改 Amazon listing(Anna ops 工作)
- ❌ 真投广告(Anna ops 工作)
