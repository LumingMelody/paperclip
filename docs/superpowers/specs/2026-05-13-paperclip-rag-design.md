# paperclip RAG Service — Design Spec

- **Date**: 2026-05-13
- **Status**: Approved (pending user review)
- **Owner**: melodylu
- **Implements**: local semantic + KG retrieval over paperclip business knowledge

## 1. Background & Motivation

paperclip 当前对业务数据（`decisions.jsonl`、`refund_comments` 84k 条、SKU 分析、Amazon reviews 等）只有正则/关键词检索能力。Agent 在生成洞察时无法语义检索"相似历史案例"或"同类客户投诉"，这是 ProductSizing、退货归因、决策回溯等工作流的核心瓶颈。

本 spec 设计一套**本地、零成本、可演进**的 RAG 基础设施：

- **零外部依赖**：模型全跑在 LM Studio（M4 Max 128GB），避免 API 成本和数据外泄
- **KG + 向量混合检索**：用 LightRAG-HKU，对实体型业务数据（SKU/客户/原因）效果远超纯向量
- **不动现有 Postgres**：LightRAG 自带 KV/向量/图三层存储，不需要 pgvector
- **渐进式落地**：先 21 条 decisions 验证链路，再阶梯式接入退货评论

## 2. Goals & Non-Goals

### Goals
- agents 通过 MCP `rag_search` 可对 decisions / refund_comments 做语义 + KG 检索
- ingest 流程幂等可续跑，单 collection 锁防并发污染
- 服务全程不读外部网络，所有模型走 LM Studio (`127.0.0.1:1234`)
- Phase 1 一天内 GA（含 e2e 验证）

### Non-Goals
- pgvector / 改造现有数据库 schema
- 实时 CDC / Kafka 增量索引（V1 手动 re-ingest 即可）
- amazon_reviews 全量入库（Phase 3 评估后再做）
- 多租户 / 权限隔离（单用户工具）
- 跨语言 reranker（先靠 hybrid mode，命中率不达标再加）

## 3. Architecture

```
                   ┌────────────────────┐
   agents ─MCP─►   │  paperclip-rag MCP │ ─HTTP─┐
                   │  (Node, thin wrap) │       │
                   └────────────────────┘       ▼
   scripts ─HTTP──────────────────────────►  ┌──────────────────────┐
                                             │  FastAPI 127.0.0.1   │
                                             │  :9001  (Python)     │
                                             │  ├ /healthz          │
                                             │  ├ /index            │
                                             │  └ /search           │
                                             │  hot LightRAG state  │
                                             └─────────┬────────────┘
                                                       │ OpenAI-compat
                                                       ▼
                                             ┌──────────────────────┐
                                             │  LM Studio :1234     │
                                             │  ├ Qwen3-30B-A3B-MLX │
                                             │  └ nomic-embed v1.5  │
                                             └──────────────────────┘

   storage:  ~/.paperclip/lightrag-storage/<collection>/
   collections: decisions  |  refund_comments  |  sizing_cases (Phase 3)
```

**职责分层**

| 层 | 职责 | 为什么这一层存在 |
|---|---|---|
| FastAPI 9001 | 长进程持有 LightRAG 状态、跑 ingest job、暴露 HTTP | 避免每次冷启动重载 KG 索引；ingest 与 search 共用一份内存状态 |
| MCP `paperclip-rag` | 薄壳包 HTTP，给 agent 暴露工具 | 沿用 paperclip-data MCP 模式；agent 端零 Python 依赖 |
| ingest CLI | 数据源 → FastAPI | 调试/批量灌库走 raw HTTP，不走 MCP |

只暴露 `rag_search` 给 agent，**不暴露 `index`**：避免 agent 误写脏数据进 KG。

## 4. Module Layout

```
services/rag/                              # 新建（Python, uv）
├── pyproject.toml
├── README.md
├── src/paperclip_rag/
│   ├── __init__.py
│   ├── config.py                          # 端点、路径、维度、模型名（环境变量覆盖）
│   ├── lm_studio.py                       # OpenAI-compat 客户端工厂（embedding + chat）
│   ├── lightrag_factory.py                # 按 collection 构造/缓存 LightRAG 实例
│   ├── api.py                             # FastAPI 路由
│   ├── schemas.py                         # Pydantic：IndexRequest/SearchRequest/...
│   └── ingest/
│       ├── __init__.py
│       ├── decisions.py                   # decisions.jsonl  → collection=decisions
│       └── refund_comments.py             # MySQL refund_comments → collection=refund_comments
├── scripts/
│   ├── run_dev.sh                         # uvicorn paperclip_rag.api:app --host 127.0.0.1 --port 9001
│   └── test_e2e.py                        # canary：索引一段文本 → search → 断言命中
└── tests/
    ├── test_lm_studio.py
    └── test_ingest_decisions.py

packages/mcp-server/src/servers/paperclip-rag/   # 新建（Node/TS）
├── index.ts
├── client.ts
└── tools/
    ├── rag_search.ts
    └── rag_collections_list.ts

launchd/com.everpretty.paperclip-rag.plist  # Phase 3 上线时再加
```

**关键 Python 依赖**：`lightrag-hku`、`fastapi`、`uvicorn[standard]`、`openai`（仅作 OpenAI-compat HTTP 客户端）、`pymysql`、`pydantic-settings`、`pytest`。

**Collection per LightRAG instance**：LightRAG 的 KG 按 working_dir 隔离，decisions 的 entity 不该跟 refund_comments 混在一个图里污染检索；每 collection 一个独立 working_dir。

## 5. API Contracts

### FastAPI（内部，127.0.0.1:9001）

```
GET  /healthz
     → 200 { status: "ok", lm_studio: "up"|"down", collections: [...] }

GET  /collections
     → 200 { collections: [{ name, doc_count, last_indexed_at }] }

POST /index
     body: {
       collection: "decisions"|"refund_comments"|...,
       docs: [{ id: str, text: str, metadata?: {...} }],
       upsert?: bool = true
     }
     → 202 { indexed: N, skipped: M, job_id?: str }
     语义：小批 <100 doc 同步；> 100 自动转后台并返回 job_id。

POST /search
     body: {
       collection: "decisions",
       query: str,
       mode?: "hybrid"|"local"|"global"|"naive" = "hybrid",
       top_k?: int = 10
     }
     → 200 {
       answer: str,           // LightRAG 综合答案
       chunks: [{ id, text, score, metadata }],
       entities: [{ name, type, description }],   // hybrid/local
       relations: [{ src, tgt, description }]     // hybrid/global
     }

GET  /jobs/{job_id}
     → 200 { status: "pending"|"running"|"done"|"failed", progress, error? }
```

错误统一 `{ error: { code, message } }`；503 = LM Studio 不可达。

### MCP 工具（agent 端）

```
rag_search(query, collection?="decisions", mode?="hybrid", top_k?=10)
  → { answer, chunks[], entities[], relations[] }

rag_collections_list()
  → { collections[] }
```

### Ingest CLI

```
python -m paperclip_rag.ingest.decisions \
    --jsonl /Users/melodylu/PycharmProjects/paperclip/decisions.jsonl

python -m paperclip_rag.ingest.refund_comments \
    --limit 500              # Phase 2 阶梯
    --since 2026-01-01       # 增量过滤
    --dry-run                # 只打印不入库
    [--force]                # 抢 collection lock
```

每次 ingest 在 working_dir 下记 `_manifest.jsonl`（source_id, content_sha256, ingested_at, chunk_count）保证幂等。

## 6. Data Flow & Ingest

### 处理流程

```
  decisions.jsonl ───────► decisions.py ──┐
                                          │
  MySQL                                   ├──► chunk(800/100) ──► entity+relation ──► Qwen3-30B   (KG 抽取)
  refund_comments ──────► refund_comments.py    │                  extraction prompt    │
                          (yield rows)          │                                       │
                                                ▼                                       ▼
                                          embedding batch ───────────────────────► Nomic v1.5    (768d 向量)
                                                │
                                                ▼
                                ~/.paperclip/lightrag-storage/<collection>/
                                  ├ kv_store_full_docs.json
                                  ├ kv_store_text_chunks.json
                                  ├ vdb_chunks.json
                                  ├ vdb_entities.json
                                  ├ vdb_relationships.json
                                  ├ graph_chunk_entity_relation.graphml
                                  └ _manifest.jsonl
```

### 性能估算（M4 Max + MLX）

| 步骤 | 模型 | 时间/chunk |
|---|---|---|
| Chunk embed | Nomic v1.5 | ~50 ms |
| KG extraction | Qwen3-30B-A3B (50–80 tok/s, ~500 输出 tok) | ~8 s |
| Entity/relation embed | Nomic v1.5 | ~100 ms |
| **合计** | | **~8 s/chunk** |

按平均 200 字/退货评论 = 1 chunk：

| 量级 | 估时 | 决策 |
|---|---|---|
| 500 条 | ~1.1 h | Phase 2a，今晚跑 |
| 5k 条 | ~11 h | Phase 2b，一晚 |
| 84k 全量 | **~187 h（8 天）** | **不接受** |

### Phase 2c 全量策略调整

**不做 84k 全量**。改为高价值子集：
- **近 90 天** + **退货金额前 80% SKU** → 估 3–8k 条 → 一晚跑完
- 覆盖率优先于完整性；冷尾长尾留给下一代硬件或 batch API

### KG 抽取 prompt 定制

LightRAG 默认 entity_types `["organization","person","geo","event"]` 对电商场景无用。覆盖：

```python
addon_params = {
  "entity_types": ["sku", "product_category", "customer_complaint",
                   "return_reason", "sizing_issue", "quality_issue",
                   "marketplace", "fulfillment_channel"],
  "example_number": 3,
  "language": "Chinese"   # 评论中英文混合
}
```

**这是关键参数**——不改的话 KG 全是没用的"地理位置/人名"，整个 RAG 价值打折。

### 配置默认值

| 项 | 值 | 备注 |
|---|---|---|
| working_dir | `~/.paperclip/lightrag-storage/<collection>/` | 集中存，方便备份 |
| chunk_token_size | 800 | 小 chunk 让 KG 更细 |
| chunk_overlap_token_size | 100 | LightRAG 默认 |
| embedding_dim | 768 | Nomic v1.5 真实维度 |
| llm_model_name | `qwen3-30b-a3b-instruct-2507` | LM Studio 加载名，环境变量可覆盖 |
| embedding_model_name | `nomic-embed-text-v1.5` | 同上 |
| openai_base | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compat |
| default search mode | `hybrid` | KG + 向量双取 |
| llm_model_max_async | 16 | LightRAG 内部并发上限 |

## 7. Error Handling

| 失败点 | 触发 | 响应 | 恢复 |
|---|---|---|---|
| LM Studio 不可达 | curl :1234 失败 | 503 `{code:"lm_studio_down"}` | 用户启 LM Studio |
| Qwen3 未加载 | /v1/models 不含期望 id | 503 `{code:"llm_not_loaded", expected, loaded}` | 用户加载模型 |
| Embedding 维度不匹配 | 启动探测 ≠ 768 | 服务拒绝启动 + 日志大字报 | 改 config 或换模型 |
| LightRAG storage 损坏 | graphml/json 解析失败 | 503 + 自动 rename `<dir>.corrupted-<ts>` | `ingest` 重建 |
| Ingest 中途崩溃 | OOM/超时 | job `failed`，已写 chunk 保留 | 续跑（manifest 幂等） |
| Search 触发 LLM 超时 | Qwen3 单次 > 120s | 504 `{code:"llm_timeout"}` | 重试或降级 `mode=naive` |
| MCP 收到 5xx | HTTP ≥ 500 | MCP 返回 `is_error: true` 附原始 msg | agent 跳过 rag |
| 并发 ingest 同 collection | 检测 lockfile | 409 `{code:"ingest_in_progress", job_id}` | 等待或 `--force` |

**日志**：`loguru`，按天滚动到 `_logs/rag/`；ingest job 单独文件。**敏感字段不打**：评论体只打 hash + 前 30 字。

## 8. Testing

### 金字塔

**Unit（pytest，CI 友好）**
- `test_lm_studio.py`：mock httpx，验证请求组装与错误处理
- `test_config.py`：环境变量覆盖、默认值
- `test_schemas.py`：Pydantic 边界（top_k、mode 枚举）
- `test_manifest.py`：幂等去重（不依赖 LightRAG）

**Integration（需 LM Studio，本地 only）**
- `test_lightrag_factory.py`：临时 working_dir，索引 1 段 → search 命中
- `test_ingest_decisions.py`：真 `decisions.jsonl` 21 行全流程，断言 manifest + KG ≥ N entity

**E2E（`scripts/test_e2e.py`，Phase 1 验收门槛）**
```
1. POST /healthz                          → assert lm_studio=up
2. POST /index  (3 条假数据)              → assert 202
3. POST /search "退货 偏小"               → assert chunks 命中 SKU 出现
4. GET  /collections                      → assert doc_count=3
5. cleanup: rm -rf working_dir/_test/
```
退出 0 = 通过。

**Phase 2a 人工抽检**：500 条 ingest 后，从 10 个真实场景 query（偏小/偏大/做工/物流损坏…）人工评判 top-3 相关性，命中率 ≥ 70%；否则回到 §6 调 entity_types + prompt。

## 9. Success Criteria

| 阶段 | Done = |
|---|---|
| Phase 1 | `scripts/test_e2e.py` 退出码 0；`decisions.jsonl` 21 条全索引；任意 1 个 decision 关键词能 hybrid search 命中 |
| Phase 2a | 500 条 refund_comments 入库；KG ≥ 100 entity / 50 relation；10 query 人工抽检命中率 ≥ 70% |
| Phase 2b | prompt + chunk 调到命中率 ≥ 80%；5k 条无 OOM |
| Phase 2c | 高金额近 90 天子集（~3–8k 条）入库；一夜无人工干预 |
| Phase 3 | MCP `paperclip-rag` 上线；≥ 1 个 routine agent 接入并产出真实价值案例 |

## 10. Trade-offs & Decisions

| 决策 | 选择 | 替代方案 & 弃用理由 |
|---|---|---|
| Agent 接口 | FastAPI HTTP + MCP 双层 | 纯 MCP：state 易丢，ingest 不好分离 / 纯 HTTP：违反 paperclip-data MCP 既有约定 |
| Phase 2 范围 | 阶梯 500 → 5k → 高价值子集 | 直接 84k：单 GPU 8 天不接受；只 decisions：太保守 |
| KG 后端 | LightRAG 自带（NetworkX graphml） | Neo4j：运维负担；pgvector：无 KG 能力 |
| Embedding 维度 | Nomic v1.5 768d | bge-m3 1024d：体积大；OpenAI text-3：违反零外网原则 |
| LLM 模型 | Qwen3-30B-A3B-Instruct-2507 MLX 4bit | Llama3-70B：M4 Max 跑慢；7B dense：KG 抽取质量不够 |
| 全量 84k | **不做**，改近 90 天 + 高金额子集 | 等下一代硬件或 batch API；覆盖率优先 |
| Realtime CDC | V1 不做 | 退货评论按周/月手动 re-ingest 足够，CDC 增加复杂度无收益 |

## 11. Out of Scope (Future)

- **多 agent prompt 接入**：Phase 3 系统化更新 5 routine agent prompts
- **跨 collection 检索**：当前每次 search 指定一个 collection；未来加 `multi: true` 合并
- **Reranker**：BGE-reranker-v2 在命中率不达标时加入
- **Amazon reviews**：评估 ROI 后决定
- **Cross-encoder fine-tune**：业务对话语料积累够后再说

## 12. Open Questions (to resolve during plan)

- `decisions.jsonl` 当前结构未确认（21 行很小，看实际再决定 chunk 策略）
- `refund_comments` 表的字段名与 join 策略（是否要 join `orders` 拿 SKU/客户）
- launchd 自启什么时候上（Phase 3 还是更早）
- 是否需要 `--collection-init` 命令重建 collection（vs 手动删 working_dir）

## 13. Plan Decomposition

本 spec 跨 Phase 1–3，但**首个 implementation plan 只覆盖 Phase 1**：

- Phase 1 plan：scaffold `services/rag/` + FastAPI + `decisions.jsonl` ingest + `test_e2e.py` 通过。
- Phase 2 plan：等 Qwen3-30B 模型本地就绪后立独立 plan，按 §6 阶梯 500/5k/子集执行。
- Phase 3 plan：MCP server + agent prompt 改造，等 Phase 2 命中率达标后再开。

每 Phase 完成后回 brainstorming skill 复核本 spec 是否需要修订。

---

**Approval log**

- 2026-05-13：sectional walkthrough §1–§5 with user，all approved。本 spec 是合并整理。
