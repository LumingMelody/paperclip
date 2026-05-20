# B2 — RAG 多账号 ingest + file_path / references 修复

**日期**: 2026-05-20
**状态**: 设计已批准，待写实现计划
**前置**: A1（chunks 填充）、A2（References 幻觉抑制）、C1（bge-m3 多语言 embedding）已 GA

---

## 1. 背景与问题

当前 paperclip-rag 的 `refund_comments` collection 只 ingest 了 **EP-US 单一账号**（Phase 2a 快照，~380 docs）。两个限制：

1. **单市场** — 决策只能覆盖美国站，无法回答 UK/DE/FR 等市场的客诉问题，也无法做跨市场对比。
2. **references 永远为空** — `api.py` 的 `/index` 端点调用 `rag.ainsert(texts, ids=ids)`，**既丢弃了 `IndexDoc.metadata`，也从不传 `file_paths=`**。LightRAG 没有 file_path 就把每个 chunk 标成 `unknown_source`，A2 当时只能整段抑制 References 输出。结果：钉钉机器人的回答没有可核对的来源。

B2 一箭双雕：把 ingest 扩到 EP 全市场，并在 ingest 时正确落地 `file_path`，让真实 references 回归。

## 2. 目标 / 非目标

**目标**
- `refund_comments` collection 覆盖 EP 全部亚马逊站点（US/UK/DE/FR/IT/ES… 由 DB 实际数据决定）。
- 每个 doc 带正确的 `file_path`，`/search` 返回的 `references` 非空且可核对。
- 钉钉机器人回答末尾附真实来源列表。
- 支持跨市场查询（同一 SKU 跨站点实体在同一 KG 内自然关联）。
- 零停机切换 —— B1 工具在生产钉钉群运行中，不可出现查询空窗。

**非目标**
- 不做增量 / 定时 ingest（独立事项，后续再排）。
- 不改 embedding 模型、不改 LightRAG 版本。
- 不引入 PZ / DAMA 品牌（本期只做 EP）。
- 不做 LightRAG 查询层的硬性 file_path 元数据过滤（跨市场用共享 KG + shop 软提示即可）。

## 3. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| Collection 策略 | **单一共享 collection** `refund_comments` | 用户需要跨市场对比；共享 KG 让同一 SKU 跨站点实体自然关联。account 维度靠 `file_path` 区分。 |
| Rollout 方式 | **旁路新建 + 原子 rename 切换**（方案 C） | B1 已在生产钉钉群运行，原地重建的数小时空窗用户可感知。复用 C1 验证过的 side-by-side playbook。 |
| 增量追加（方案 B） | **否决** | 现有 380 条 US doc 无 file_path，追加后会出现「US 无来源、其他市场有来源」的不一致，正好砸了「修好 references」的目标。必须连 US 一起重灌。 |
| B1 `shop` 参数 | **改为可选** | 传 shop → 单市场范围提示；不传 → 跨市场查全部。机器人按问题自行决定。 |
| references 产物 | **机器人回答附来源列表** | A2 的 References 抑制针对的是 LLM 幻觉的*假*来源；B2 落地 file_path 后是*真*来源，反转合理。 |

## 4. 账号映射（已确认）

RAG ingest 侧 `refund_comments.py` 的 `--account` 参数对应 `dm_allretrun_analysis_d.Account` 列，实际取值为 **`EverPretty-{COUNTRY}`** 风格（C1 ingest 实跑确认，如 `EverPretty-US`、`EverPretty-UK`）。

> 注意：`client.ts::shopToAccount` 产出的 `AmazonEP{XX}` 是**另一套**——给 dws `_query.py` 的退货率机器人工具用的。B2 不碰 `client.ts`：B1 RAG 工具用共享 collection `refund_comments`，`shop` 仅作查询提示，不做 account 翻译。

ingest 编排脚本**不硬编码市场列表**，运行时从 DB 发现：

```sql
SELECT DISTINCT Account FROM dm_allretrun_analysis_d WHERE Account LIKE 'EverPretty-%'
```

account → shop 逆映射：`EverPretty-UK → EP-UK`（剥掉 `EverPretty-` 前缀，前置 `EP-`）。

## 5. 设计

### ① Ingest 编排层

新增 `services/rag/src/paperclip_rag/ingest/refund_comments_all.py`：

- 连 DB，`SELECT DISTINCT Account LIKE 'AmazonEP%'` 发现所有 EP 账号。
- 逐账号复用 `refund_comments.py` 现有的取数 / 构 doc 逻辑（重构为可被 import 的函数，不再只是 `main()` 内联）。
- 所有 doc 灌进**同一个 collection**（切换前为 `refund_comments_v2`，切换后即 `refund_comments`），collection 名由 CLI 参数 `--collection` 控制。
- 每个 doc 设：
  - `file_path = "{shop}/{sku}/{orderId}"`，例 `EP-UK/EE02968/302-1234567-1234567`。`shop` 由 account 逆映射得到。含 SKU 是为了 ③ 的来源列表能渲染「站点 / SKU / 订单」三段。
  - `id = "{shop}::{orderId}::{sku}"` —— 加 shop 前缀防止跨市场 orderId/sku 撞 id（现有单账号 id 是 `{orderId}::{sku}`）。
  - orderId / sku 为空时，对应段填 `unknown`，保证 file_path 段数稳定可解析。
- manifest 幂等性保留：`_manifest.jsonl` 仍按 `(source_id, content_sha256)` 去重，编排脚本跑在新 collection 目录下，manifest 自然隔离。
- CLI 参数：`--since`、`--limit`（每账号上限）、`--collection`、`--api-base`、`--dry-run`、`--force`。
- 单账号 ingest 失败不中断整体：记录并继续下一账号，末尾汇总报告。

`refund_comments.py` 重构：把「取数 → 构 doc list」抽成 `build_docs(conn, account, since, sku_prefix, limit) -> list[dict]` 供编排脚本与原 `main()` 共用。`main()` 保持单账号 CLI 入口不变（向后兼容）。

### ② RAG 服务端：`/index` 透传 file_path

根因修复，纯增量、不破坏现有调用：

- `schemas.py::IndexDoc` 加字段 `file_path: str | None = None`。
- `api.py::index` 改为：
  ```python
  texts = [d.text for d in req.docs]
  ids = [d.id for d in req.docs]
  file_paths = [d.file_path or d.id for d in req.docs]
  await rag.ainsert(texts, ids=ids, file_paths=file_paths)
  ```
  （`file_path` 缺省回退到 `id`，保证旧调用方不传时不报错、也不再是 `unknown_source`。）
- 不动 `LightRAGFactory`、不动 collection 路由逻辑。

### ③ Search 链路 + B1 工具

**RAG 后端**：`/search` 已经返回 `references`（`api.py::_to_reference` 已就位），KG/chunk 的 `file_path` 已透传。**后端 search 无需改动** —— ② 修好 ingest 侧后，references 自然非空。

**B1 工具 `packages/tool-registry/src/tools/rag/searchRefundComments.ts`**：
- `shop` 参数：保留 `SHOP_RE` 格式校验，但**改为可选**（`.optional()`）。删除 `SUPPORTED_SHOPS` 白名单 `.refine()`（EP 全市场已 ingest）。
- 传 `shop` → 把市场范围作为提示注入 query（如在 query 前加 `（限定店铺：EP-UK）`）；不传 → 不注入，跨市场查全部。
- `outputSchema` 加 `references` 字段透传：`z.array(z.object({ referenceId: z.string(), filePath: z.string() }))`。
- `description` 更新：删掉「EP-US only, 380 docs」「Other shops will reject」，改为 EP 全市场覆盖、shop 可选的说明。
- **handler 把来源列表直接拼进 `answer` 字符串末尾**：每条解析 `file_path` 的 `{shop}/{sku}/{orderId}` 渲染为「站点 / SKU / 订单」。

**渲染策略修正**：钉钉机器人是独立 repo（`~/PycharmProjects/paperclip-dingtalk-bot/`），Pattern C LLM-dispatcher 通过 CLI 调本仓 tool-registry 工具。为避免跨 repo 协调，B2 **不改钉钉 repo**——B1 工具 handler 自己把来源段拼进 `answer`，钉钉 bot 原样渲染 `answer` 即显示。`outputSchema.references` 仍保留作结构化透传，供未来消费者使用。

### ④ 切换 playbook（零停机）

1. 编排脚本灌 `refund_comments_v2`（全 EP 市场，带 file_path），后台运行，预计数小时。
2. 灌完验证：
   - 跑若干已知 query，确认 `/search` 返回的 `references` 非空。
   - 抽查 file_path 形如 `EP-UK/...`。
   - 跨市场 query（如某跨站点 SKU）能召回多个站点的 chunk。
3. 验证通过 → 停 RAG 服务 → `mv refund_comments refund_comments_pre-b2-<ts>` + `mv refund_comments_v2 refund_comments` → 起服务。B1 仍指向 `refund_comments`，零感知。
4. 旧目录 `refund_comments_pre-b2-<ts>` 保留作回滚，稳定运行后再删。
5. 回滚 = 反向 rename + 重启，纯目录操作，无需 revert 代码。

### ⑤ 测试

- **`IndexDoc.file_path` 透传**：单测 `/index`，注入带 `file_path` 的 doc，断言 mock factory 的 `ainsert` 收到 `file_paths=` 且值正确；不传 `file_path` 时回退到 `id`。
- **编排脚本**：单测 account 逆映射（`AmazonEPUK`→`EP-UK`）、doc id 加 shop 前缀、`file_path` 拼接、单账号失败不中断。
- **B1 工具**：单测 `shop` 可选（传 / 不传都通过校验，非法格式仍拒绝）、`references` 透传 `outputSchema`。
- **端到端验证**：放在 ④ step 2（人工 + 脚本），不进 CI。

## 6. 影响文件

| 文件 | 改动 |
|---|---|
| `services/rag/src/paperclip_rag/ingest/refund_comments_all.py` | 新增——多账号编排脚本 |
| `services/rag/src/paperclip_rag/ingest/refund_comments.py` | 重构——抽 `build_docs()`，`main()` 兼容不变 |
| `services/rag/src/paperclip_rag/schemas.py` | `IndexDoc` 加 `file_path` 字段 |
| `services/rag/src/paperclip_rag/api.py` | `/index` 传 `file_paths=` 给 `ainsert` |
| `packages/tool-registry/src/tools/rag/searchRefundComments.ts` | `shop` 可选、删白名单、`outputSchema` 加 `references`、description 更新 |
| 钉钉机器人回复组装代码（实现期定位） | 渲染来源列表 |
| 测试文件（对应各模块） | 新增 / 更新单测 |

## 7. 风险

- **重灌耗时** — 全市场 doc 数远超 US 的 380，re-ingest 可能十几小时（C1 单市场 ~407 doc 用了 ~65min）。缓解：旁路新建不影响线上；后台跑；编排脚本支持单账号失败续跑。
- **LightRAG file_path → references 行为** — 已验证 `ainsert` 接受 `file_paths=`（LightRAG 1.4.16），`operate.py` 使用 `file_path` 构 references。实现计划须有一步显式验证：灌入带 file_path 的 doc 后 `/search` 的 `references` 确实非空。
- **跨市场污染** — 共享 KG 下单市场提问可能召回他站 chunk。缓解：shop 软提示注入 query；references 带 file_path 可审计；钉钉用户本就按 shop 提问，问题域已收窄。v1 接受软过滤。
- **doc id 迁移** — 新 id 格式 `{shop}::{orderId}::{sku}` 与旧 `{orderId}::{sku}` 不同。因为是全新 collection + 全量重灌，无迁移问题；manifest 也在新目录隔离。

## 8. 回滚

- 切换前：`refund_comments_v2` 与线上 `refund_comments` 并存，B1 不受影响。
- 切换后出问题：反向 rename（`refund_comments` ↔ `refund_comments_pre-b2-<ts>`）+ 重启服务。纯目录操作。
- 代码层（②③）是纯增量、向后兼容，即使切换回旧 collection 也不会报错（旧 doc 无 file_path，references 回到空，行为等同 B2 之前）。
