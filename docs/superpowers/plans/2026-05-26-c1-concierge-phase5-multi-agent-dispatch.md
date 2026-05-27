# C1 — Phase 5: Concierge → 业务 Agent Sub-issue 接力

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Concierge 在识别到"跨部门 / 多视角 / 决策类"问题时，**派 sub-issue 给业务 agent**（Finance / ProductSizing / Supply / CXOps / Marketing / Research），收集各 agent 的专业视角答复后**聚合成最终回答**写回主 issue。从"Concierge 一人扛 23 工具自答" → "Concierge 路由 + 业务 agent 分工"，解锁 paperclip 平台真正的多 agent 价值。

**Architecture:** 用户问钉钉 bot → `/api/chat` → Concierge 拿到主 issue → Concierge 在 system prompt 引导下判定"是否跨部门" → 是 → 调 `POST /api/companies/:companyId/issues`（已就位的 paperclip 控制面 API）创建 1-N 个 sub-issue（`parentId` = 主 issue.id, `assigneeAgentId` = 对应业务 agent, `blockParentUntilDone: true` 让主 issue 阻塞），各业务 agent 独立 run、写 comment、设 done → Concierge 监听 sub-issue 完成（轮询 `GET /api/issues/:id/heartbeat-context` 或 `/comments`）→ 全部 done 后拉各家答案 → 用 markdown 表格 / 三段式聚合写主 issue comment + 设主 issue done → bot 短轮询拉到 → 推钉钉。

**Tech Stack:**
- 不新建任何 schema（`parentId` / `blockedByIssueIds` / `issue_relations` / `createChildIssueSchema` 全部就位）
- 不新建任何工具（`skills/paperclip/SKILL.md` 已给 Concierge 完整 HTTP 控制面 — Step 9 明确教如何调 `POST /api/companies/{companyId}/issues` 派 sub-issue）
- 不新 seed agent（12 个 agent 全部就位 + 有 prompt）
- 改动范围：**纯 prompt 工程** —— `docs/agents/concierge.md`（Concierge 引导）+ 业务 agent 各自的 instructionsBundle（chat-sub-issue 模式段）

**Why so small:** Phase 5 原估 6+ 小时（含建 dispatch 基础设施），discovery 发现 paperclip 已经把"sub-issue 派单"做成 first-class capability — 主任务塌缩为"教会 Concierge 用现有能力"。

---

## 关键架构决策（写在前面避免歧义）

1. **派单触发条件 = "跨部门 + 决策类"**。Concierge 用关键词 + 语义判断：含"决策 / 该不该 / 治理 / 评估 / 综合分析 / 跨"或同时涉及 ≥ 2 个部门视角 → 派单；纯数据查询（"退货率多少 / 销量多少 / Top N"）→ Concierge 自答。
2. **Sub-issue 走 `blockParentUntilDone: true`**。让 paperclip 内置的 blocked-by 机制处理"等子任务完成"，不让 Concierge 自己写 while-loop 轮询代码。子 issue done 后 paperclip 自动解除主 issue blocked 状态 + 通知 Concierge。
3. **业务 agent 派单时进入"chat-sub-issue 模式"**。它们日常 mode 是"接收 Anna 的复杂任务，写 brief / 跑分析 / 出落地建议"——长篇结构化输出。但 chat-sub-issue 场景需要**简答**（200 字以内的专业观点 + via 工具）。靠 prompt 加一段触发条件识别。
4. **Concierge 聚合用统一模板**。避免每个业务 agent 报回不同格式让用户看着乱：定义"sub-issue 答复必填字段"（结论 / 证据 / 信心度 / 数据范围）+ Concierge 用一致 markdown 表格聚合。
5. **MVP 选 6 个业务 agent**：Finance、ProductSizing、Supply、CXOps、Marketing、Research。CEO/CMO/CTO 是高层综合 role，不参与单题派单；DataPlatform 是技术 agent，用户问"为什么数据是这样"才派；ClosedLoopChecker 是 routine 触发的。
6. **失败兜底**：sub-issue 任意一个超时（10 分钟未完成）或返 error，Concierge 标 "⚠️ [agent_name] 暂不可用，回答基于剩余信息"，不让一个 agent 故障 block 整个回答。

---

## File Structure

```
docs/agents/
├─ concierge.md              ← 主要改造（加 §dispatch 段 + §aggregation 段 + agent routing 矩阵）
├─ finance.md                ← 加 §chat-sub-issue 模式段
├─ product_sizing.md         ← 加 §chat-sub-issue 模式段
├─ supply.md                 ← 加 §chat-sub-issue 模式段
├─ cx_ops.md                 ← 加 §chat-sub-issue 模式段
├─ marketing.md              ← 加 §chat-sub-issue 模式段
└─ research.md               ← 加 §chat-sub-issue 模式段

docs/superpowers/specs/
└─ 2026-05-26-c1-concierge-phase5-spec.md  ← 验收记录（最后一步写）

scripts/
└─ phase5-push-agent-prompts.sh   ← 新文件：把 6 个业务 agent 的 prompt 推到 runtime（参考 phase 2 的 PUT /agents/:id/instructions-bundle/file）
```

**不动**:
- 任何 .ts / .py 代码（所有控制面操作都通过 paperclip skill 已给的 HTTP API 完成）
- 任何 DB schema
- tool-registry

---

## Phase 0 — Discovery（必做，不能跳）

### Task 0.1: 确认 6 个业务 agent 的现有 prompt 在哪 + 长什么样

**Files:**
- Read: `docs/agents/finance.md`, `docs/agents/product_sizing.md`, `docs/agents/supply.md`, `docs/agents/cx_ops.md`, `docs/agents/marketing.md`, `docs/agents/research.md`
- Read runtime snapshot: `/Users/melodylu/.paperclip/instances/default/companies/a0f62167-5f88-475b-bdc0-3d4cb80184dc/agents/<each-uuid>/instructions/AGENTS.md`

**Agent UUID 速查** (来自 GET /api/companies/<companyId>/agents):
- Finance: `ffbebaee-...`
- ProductSizing: `af07531d-...`
- Supply: `960b5f82-...`
- CXOps: `7f619fcd-...`
- Marketing: `0f4f087f-...`
- Research: `6ab1f6fa-...`

- [x] **Step 1: 检查每个 agent 的 source prompt 与 runtime snapshot 是否一致** (6/6 缺 source — 全部只有 runtime)

- [x] **Step 2: 如果某个 agent 没有 source markdown（只有 runtime snapshot），把 runtime 反向同步到 docs/agents/** (6 file copied → snake_case naming)

- [x] **Step 3: 把这些 source markdown 全部 commit 一次，作为 Phase 5 改造的 baseline** (commit 1045 inserts)

### Task 0.2: 验证 sub-issue 派单链路（手动 smoke test）

**Files:** 无新文件，纯 curl 实验

- [x] **Step 1: 手动派一个 sub-issue 给 ProductSizing，验证派单成功 + 业务 agent 能接到**
  - parent: `3d603133-56b3-41e8-a7a6-37a817431f8c`
  - sub-issue: `521ac10e-c6d0-4a81-a348-c3cf9afba9da` assigned to ProductSizing
  - 创建即 HTTP 201, parentId/assigneeAgentId 正确

- [x] **Step 2: 观察 ProductSizing 是否在 ~90s 内 pickup 并写 comment** (pickup + done in **75 秒** ✅)
  - T+0s: status=in_progress (Concierge 处于 in_progress 后 wake fired immediately)
  - T+75s: status=done with substantive markdown comment from ProductSizing UUID `af07531d`
  - 答复内容引用了真实工具调用 (`lingxing.styleSummary` + `rag_searchRefundComments`) 而非编造

- [x] **Step 3: 把结论写到 spec doc** (recorded in Phase 3 spec doc — Phase 0 smoke proof: 内置 wakeup 自动工作, **不需要 Concierge 写轮询**, 单 sub-issue 平均完成时间 ~75-90s)

---

## Phase 1 — Concierge prompt 改造（核心）

### Task 1.1: 在 docs/agents/concierge.md 加 §dispatch 决策段

**Files:**
- Modify: `docs/agents/concierge.md`（插入位置：现有 "退货分析专题输出规范" 段之后、"RAG vs DWS" 段之前）

- [x] **Step 1: 加 §跨部门派单决策 段** (含触发条件 — 关键词 + 结构 + 不派单白名单)

- [x] **Step 2: 加 §业务 agent 选择矩阵** (6-agent 路由表 + CEO/CMO/CTO 排除说明)

| 关键词 / 信号 | 派给 | UUID | 适合做 | 不适合做 |
|---|---|---|---|---|
| 净利润 / 利润率 / 成本 / 现金流 / ROI | Finance | ffbebaee-... | 单 SKU 利润测算、广告 ROI、毛利分析 | 选品决策（让 ProductSizing 出尺码视角） |
| 退货率 / 偏大偏小 / 尺码表 / 加码减码 / 版型 | ProductSizing | af07531d-... | 尺码诊断、放码建议、退货归因 | 财务测算 |
| 补货 / 停售 / 库存 / 周转 / 缺货 | Supply | 960b5f82-... | 补货优先级、停售候选、库存测算 | 退货归因 |
| listing / 主图 / 描述 / 客户反馈 / 客服 / 复购 | CXOps | 7f619fcd-... | listing 一致性核查、客服 SOP | 财务、补货 |
| 广告 / ROAS / Meta / Bing / Criteo / Campaign | Marketing | 0f4f087f-... | 广告诊断、跨平台预算分配 | 自然流量、SEO（让 Research 兜底）|
| 竞品 / 趋势 / 市场 / 流量 / SimilarWeb | Research | 6ab1f6fa-... | 竞品流量分析、趋势洞察 | 内部数据问题 |

- [x] **Step 3: 加 §派单 payload 模板** (含 parentId / projectId / title / description / status / assigneeAgentId + paperclip skill Step 9 引用)

```bash
POST /api/companies/{companyId}/issues
{
  "parentId": "{{ 主 issue.id }}",
  "projectId": "{{ project_id }}",
  "title": "[Concierge派单] {{ 一句话主旨 }}",
  "description": "**背景**: {{ 主问题 }}\n**Concierge 已知**: {{ 已查到的数据点摘要 }}\n**需要你给的**: {{ 该 agent 视角的 1-3 条结论 + 信心度 + 证据 }}",
  "status": "todo",
  "assigneeAgentId": "{{ 业务 agent UUID }}",
  "blockedByIssueIds": []
}
```

- [ ] **Step 4: Commit**
  ```bash
  git add docs/agents/concierge.md
  git commit -m "docs(c1/phase5): concierge dispatch decision matrix"
  ```

### Task 1.2: 在 docs/agents/concierge.md 加 §aggregation 段

**Files:**
- Modify: `docs/agents/concierge.md`

- [ ] **Step 1: 加 §等待 sub-issue + 聚合 段**

写明：
- 派完 sub-issue 后**不要立刻答主问题**——主 issue 应保持 status=in_progress，让 paperclip 的 blocked-by 机制接管
- Concierge 等待 sub-issue 完成的策略：用 `GET /api/issues/{sub-id}/heartbeat-context` 轮询（5s 间隔），每个 sub-issue 超时 10 分钟（业务 agent run 通常 1-3 分钟）
- 全部 sub-issue done → 拉每个 sub-issue 的最后一条 comment（filter `authorAgentId == 该业务 agent UUID`）
- 聚合输出统一格式：
  ```markdown
  ## 决策汇总
  | 视角 | 结论 | 信心 | 关键证据 |
  |---|---|---|---|
  | Finance | ... | 高/中/低 | via 工具 |
  | ProductSizing | ... | 高/中/低 | via 工具 |
  ...

  ## Concierge 综合建议
  （基于上述视角的综合判断 2-4 条）

  via Concierge 派单 → Finance + ProductSizing + Supply (任何已涉及的 agent)
  ```

- [ ] **Step 2: 加 §sub-issue 失败兜底 段**

写明：任一 sub-issue 超时或返 error，标 `⚠️ [agent_name] 暂不可用` 在对应表行，继续聚合剩余视角，不阻塞最终回答。

- [ ] **Step 3: Commit**
  ```bash
  git add docs/agents/concierge.md
  git commit -m "docs(c1/phase5): concierge sub-issue aggregation + fallback"
  ```

### Task 1.3: 推 Concierge 新 prompt 到 runtime

- [ ] **Step 1: PUT 新 instructions-bundle**
  ```bash
  PAYLOAD="$(python3 -c "
  import json, pathlib
  content = pathlib.Path('docs/agents/concierge.md').read_text(encoding='utf-8')
  print(json.dumps({'path': 'AGENTS.md', 'content': content, 'clearLegacyPromptTemplate': False}, ensure_ascii=False))
  ")"
  rtk proxy curl -sS -X PUT \
    "http://127.0.0.1:3100/api/agents/40560fc7-a40b-4106-806f-95a7060c8e0b/instructions-bundle/file" \
    -H 'content-type: application/json' \
    -d "$PAYLOAD" \
    -w 'HTTP %{http_code}\n'
  # 验证 runtime snapshot 行数对得上
  wc -l /Users/melodylu/.paperclip/instances/default/companies/a0f62167-5f88-475b-bdc0-3d4cb80184dc/agents/40560fc7-a40b-4106-806f-95a7060c8e0b/instructions/AGENTS.md docs/agents/concierge.md
  ```

---

## Phase 2 — 业务 agent prompt 加「chat-sub-issue 模式」段

### Task 2.1: 给 6 个业务 agent 各加一段「被 Concierge 派单时的简答模式」

**Files:**
- Modify: `docs/agents/finance.md` `docs/agents/product_sizing.md` `docs/agents/supply.md` `docs/agents/cx_ops.md` `docs/agents/marketing.md` `docs/agents/research.md`

每个文件加这段（按 agent 的领域改关键词）:

```markdown
## Chat-sub-issue 简答模式

当主 issue 的 title 以 `[Concierge派单]` 开头时（或 description 里 explicit 提到"该 agent 视角的简答"），**进入简答模式**，不要按平时的"长篇 brief + 落地清单"模板回。

简答模式输出（≤ 200 字 + 表格 ≤ 6 行）:

```
## 结论
（1 句，给主问题最直接的答复）

## 证据
| 数据点 | 数值 | 数据范围 |
|---|---|---|
| ... | ... | ... |

## 信心度
高 / 中 / 低 — （如果中/低，说原因，如样本不足、口径限制）

via {{ 你实际调用的工具列表 }}
```

回完即设主 issue (sub-issue) 的 status=done，Concierge 会自动聚合。
```

- [ ] **Step 1: 给 finance.md 加上面段（关键词改"利润 / 成本"）**
- [ ] **Step 2: 给 product_sizing.md 加（关键词改"尺码 / 版型 / 退货归因"）**
- [ ] **Step 3: 给 supply.md 加（关键词改"补货 / 库存"）**
- [ ] **Step 4: 给 cx_ops.md 加（关键词改"listing / CX"）**
- [ ] **Step 5: 给 marketing.md 加（关键词改"广告 / ROAS"）**
- [ ] **Step 6: 给 research.md 加（关键词改"竞品 / 趋势"）**

- [ ] **Step 7: Commit**
  ```bash
  git add docs/agents/finance.md docs/agents/product_sizing.md docs/agents/supply.md docs/agents/cx_ops.md docs/agents/marketing.md docs/agents/research.md
  git commit -m "docs(c1/phase5): 6 业务 agent 加 chat-sub-issue 简答模式"
  ```

### Task 2.2: 写脚本批量推 6 个 agent 的 prompt 到 runtime

**Files:**
- New: `scripts/phase5-push-agent-prompts.sh`

- [ ] **Step 1: 写脚本（bash + curl，参考 phase 2 seed-concierge-agent.sh 模式）**

```bash
#!/usr/bin/env bash
# Push updated docs/agents/<name>.md prompts to runtime via paperclip's
# PUT /api/agents/:id/instructions-bundle/file endpoint.
set -euo pipefail

BASE="${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}"

declare -A AGENT_UUIDS=(
  ["finance"]="ffbebaee-..."
  ["product_sizing"]="af07531d-..."
  ["supply"]="960b5f82-..."
  ["cx_ops"]="7f619fcd-..."
  ["marketing"]="0f4f087f-..."
  ["research"]="6ab1f6fa-..."
)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for name in "${!AGENT_UUIDS[@]}"; do
  UUID="${AGENT_UUIDS[$name]}"
  SRC="$REPO_ROOT/docs/agents/${name}.md"
  [ -f "$SRC" ] || { echo "skip: $SRC missing" >&2; continue; }

  PAYLOAD="$(python3 -c "
import json, pathlib
content = pathlib.Path('$SRC').read_text(encoding='utf-8')
print(json.dumps({'path': 'AGENTS.md', 'content': content, 'clearLegacyPromptTemplate': False}, ensure_ascii=False))
")"

  HTTP="$(curl -sS -o /tmp/phase5-push.$name.json -w '%{http_code}' \
    -X PUT "$BASE/api/agents/$UUID/instructions-bundle/file" \
    -H 'content-type: application/json' \
    -d "$PAYLOAD")"

  if [ "$HTTP" = "200" ]; then
    echo "✅ $name → HTTP 200 ($(wc -l < $SRC) lines)"
  else
    echo "❌ $name → HTTP $HTTP" >&2
    cat /tmp/phase5-push.$name.json >&2
  fi
done
```

- [ ] **Step 2: chmod +x + 运行**

- [ ] **Step 3: 用 wc 验证每个 runtime AGENTS.md 行数对上 source**

- [ ] **Step 4: Commit**
  ```bash
  git add scripts/phase5-push-agent-prompts.sh
  git commit -m "feat(c1/phase5): bulk push agent prompts to runtime"
  ```

---

## Phase 3 — 端到端验证

### Task 3.1: 用复合问题触发多 agent 接力

- [ ] **Step 1: 在钉钉群 @bot 发**

  > `@EverPretty 智能助手 EE02559 退货 73.7% 这么高，该不该停售？给我决策依据 + 落地动作`

- [ ] **Step 2: 观察 paperclip UI**

  预期行为：
  1. 主 issue 创建（Concierge）→ status=in_progress
  2. Concierge 判定为"决策类 + 跨部门" → 派 sub-issue 给 ProductSizing（尺码诊断）、Finance（剩余利润空间）、Supply（清仓 / 改单候选）
  3. 3 个 sub-issue 在 1-3 分钟内 done
  4. Concierge 拉 3 家的 comment 聚合
  5. 主 issue done → bot 推回钉钉
  6. 钉钉看到的答复末尾 via 应该包含 `Concierge 派单 → ProductSizing + Finance + Supply`

- [ ] **Step 3: 把验收 trace 截图 + 关键日志贴到 spec doc**

### Task 3.2: 故障注入验聚合容错

- [ ] **Step 1: 把 Supply agent 临时 idle 掉**（PATCH /api/agents/<supply-uuid> status=idle）

- [ ] **Step 2: 再问一次 step 1 的问题**

- [ ] **Step 3: 预期：Concierge 等 Supply 超时后，标 ⚠️ Supply 暂不可用，照常聚合 ProductSizing + Finance 答案**

- [ ] **Step 4: 验证完恢复 Supply**

### Task 3.3: 写 spec 文档

**Files:**
- New: `docs/superpowers/specs/2026-05-26-c1-concierge-phase5-spec.md`

- [ ] **Step 1: 写 spec**

包含：
- 测试问题 + 预期 vs 实际行为
- 各 sub-issue 的 createdAt → doneAt 耗时
- Concierge 最终聚合输出截图（钉钉群里那条）
- 故障注入 trace
- 已知限制 + 下次迭代候选

- [ ] **Step 2: Commit**
  ```bash
  git add docs/superpowers/specs/2026-05-26-c1-concierge-phase5-spec.md
  git commit -m "docs(c1/phase5): e2e verification + fault injection spec"
  ```

---

## Self-Review 记录

- **Discovery 关键发现**：paperclip 已经把 sub-issue 派单做成 first-class capability — `parentId` / `blockedByIssueIds` / `issue_relations` / `createChildIssueSchema.blockParentUntilDone` 全部就位，而且 `skills/paperclip/SKILL.md` 已经在 Step 9 给 Concierge 教过怎么调 `POST /api/companies/{companyId}/issues`。所以 Phase 5 不是"建 dispatch 基础设施"，是"教会 Concierge 用现有能力"。
- **Scope 控制**：纯 prompt 工程 + 1 个 bash 脚本，**不动 .ts / .py / DB schema / tool-registry**。如果实施中发现需要改这些，说明 scope creep，应该停下来重新讨论。
- **6 vs 11 agent 选择**：CEO/CMO/CTO 是高层综合 role，不参与单题派单（防止"决策递归"——Concierge 不应该让 CEO 这种高层 agent 介入单题决策）；DataPlatform 是技术 agent；ClosedLoopChecker 是 routine 触发的。所以业务 agent 真正涵盖 6 个就够。
- **Sub-issue 阻塞机制**：用 paperclip 内置的 `blockParentUntilDone: true` —— Concierge **不需要写 while-loop 轮询代码**。paperclip 的 issue 状态机自动处理"等子任务完成"。如果发现这个机制不工作，是 Phase 5 之外的 paperclip bug，应该分开 issue。
- **失败兜底**：Sub-issue 超时（10 min）不阻塞最终回答 —— 关键 UX 原则。一个 agent 故障不应该让用户在群里等 ∞。
- **总工作量预估**：Phase 0（30 min discovery）+ Phase 1（30 min prompt 改）+ Phase 2（45 min × 6 agent 简答模式 + 推 runtime）+ Phase 3（30 min 验证）= **2 小时 ± 30 分钟**。比原估的 6+ 小时小三分之二。
