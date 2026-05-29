# 独立站 (Shopify) 操作接入 tools 层 — 可行性盘点与实施依据

> 状态：2026-05-29 与 Codex 设计讨论 + 多 agent 穷尽盘点后定稿。本文是后续分批实施的依据，不是已完成清单。

## 一、核心结论：能，但读 / 写是两条完全不同的路

凡是 Shopify Admin API 能做的，理论上都能进 paperclip 能力面 —— 但读和写在 tools 层**完全不对称**：

- **读操作 = 纯 tool-registry 加法**。照抄现有 `src/tools/shopify/getProduct.ts`（live Admin API + urllib helper）或 `src/tools/dws/siteTopStyles.ts`（DWS SQL + `_query.py`）的 Zod 两件套，**零框架改动**。
- **写操作今天进不了 tools 层**。`ToolDescriptor.readOnly` 的 TS 类型被钉死成字面量 `true`（见 `packages/tool-registry/src/registry.ts`）。任何会改数据的描述符要么撒谎写 `readOnly:true`，要么写 `readOnly:false` 直接 `tsc` 编译失败。

## 二、已定架构（写操作走治理通道，永不裸接 MCP）

```
Concierge / MCP 工具   ── 只读分析 + dry-run 预览（绝不 mutate）
        ↓
Paperclip issue + 看板审批   ── 唯一人工审批门 + 审计链接
        ↓
Paperclip 后端 execute broker  ── 审批通过后由服务端（不是 agent）调用
        ↓
独立站需求 FastAPI 机器 API   ── service-token 鉴权 / 任务 / 按店锁 / dry-run / execute / audit CSV / 持有 Shopify token
        ↓
Shopify Admin API
```

铁律：
- 写操作**绝不**做成 raw MCP 工具（连 gated 都不行）；execute 是 Paperclip 后端动作。
- DTC 侧要**新加机器 API**（service-token + `plan_hash` + 幂等 key），不复用 webapp 现有的浏览器 session 路由（那套只覆盖 price/open/close）。
- Paperclip **永不持有** Shopify token；token 留在 `独立站需求/token.txt`。
- 第一个开放的写应是 **`inventory_policy close`（停售）**：语义最窄、最不破坏。

代码现状（全在 `/Users/melodylu/PycharmProjects/独立站需求/shopify`）：
- CLI 写操作：`update_product_status.py`（上下架）、`update_variant_price.py` + `core/variant_price.py`（改价）、`update_continue_selling.py`/`update_stop_selling.py` + `core/inventory_policy.py`（开售/停售）、`update_product_tags.py`（标签）。都是默认 dry-run → `--execute` → audit CSV。
- webapp：`webapp/backend`（FastAPI 任务队列 + 鉴权 + 文件上传），但 `routes/job_routes.py` **只包 price/open/close**；status/tags 还是 CLI-only，要先提升进 core+job。

## 三、⚠️ 关键工程前置坑：REST 写端点已废弃

Shopify 的 product / variant / inventory **写端点自 2025-04 起对新 app 废弃，必须用 GraphQL Admin API**。而现有 `_query.py` / 工具是 **REST-only**。

→ **任何写操作上线前，得先补一个 GraphQL Admin client**。这是治理通道之外的独立基础工程缺口。
→ 另：`config.py` 写 `API_VERSION="2025-07"` 但多个 client 硬编码 `2025-04`，受控写前要在 DTC 仓库修齐。

## 四、操作分类全表（合并已实现 + Admin API 缺口，按 category 去重）

| 操作类别 | 读/写 | 已建? | 在 tools 层如何落地 | 风险 |
|---|---|---|---|---|
| product 读 (by-handle 已有；by-id/search/productById 缺) | 读 | 部分 | MCP 只读工具，直接加 | none |
| product 写 (Create/Update/Set/Delete/Duplicate、media、SEO) | 写 | 否 | 治理写通道 | high (delete/create/update) · medium (duplicate/media/SEO) |
| status active/draft/archived | 写 | 是(独立站) | 治理写通道（archive 近不可逆） | high |
| publish/unpublish 到销售渠道 | 写 | 否 | 治理写通道；先加 publications 只读 | medium · 读 none |
| variant 写 (price、bulkCreate/Update/Delete/Reorder、options) | 写 | 部分(price 已有) | 治理写通道 | high (price/create/delete) · low (reorder) |
| price 读/写 (compareAtPrice、Markets priceList、inventoryItem cost) | 写 | 部分 | 治理写通道 | high (price/markets) · medium (cost) |
| inventory policy (continue/deny) | 写 | 是(独立站) | 治理写通道（**第一个写操作**） | medium |
| inventory 量 (setQuantities/adjust/activate/move) | 写 | 否 | 治理写通道（oversell 风险，需 locationId） | high (set/adjust) · medium (activate/move) |
| inventory/locations 读 (levels、locations) | 读 | 否 | MCP 只读工具，直接加 | none |
| tag 写 (product add/remove 已有、replace；orders/customers 标签缺) | 写 | 部分 | add/remove 走治理，可作早期写 | low (add/remove) · high (replace 全覆盖) |
| collection 读 (collections-as-objects、ruleSet) | 读 | 否 | MCP 只读工具，直接加 | none |
| collection 写 (create/update/add/remove/reorder/delete products) | 写 | 否 | 治理写通道 | medium · low (reorder) |
| metafield/metaobject 读 | 读 | 否 | MCP 只读工具，直接加 | none |
| metafield/metaobject 写 (metafieldsSet/Delete、definition、metaobject) | 写 | 否 | 治理写通道（独立站有 group-tag→metafield 需求文档，无代码） | medium |
| order 读 (committed 已有；draftOrders、fulfillmentOrders 缺) | 读 | 部分 | MCP 只读工具，直接加 | none |
| order 写 (create/update/close/cancel/edit/markAsPaid/draftOrder) | 写 | 否 | 治理写通道（动钱、面向客户，最高危） | high · medium (orderUpdate 注记) |
| refund/return 写 (refundCreate、return 工作流) | 写 | 否 | 治理写通道；suggestedRefund 先做只读预览 | high · 读 none |
| fulfillment 写 (create/cancel/tracking/hold/move) | 写 | 否 | 治理写通道（3PL/物流，价值需确认） | high · medium (tracking) |
| customer 读 (基础已有；segment/高级搜索缺) | 读 | 部分 | MCP 只读工具，直接加 | none |
| customer 写 (create/update、marketing consent、merge/delete) | 写 | 否 | 治理写通道（consent/delete 合规敏感） | medium · high (consent/merge/delete) |
| discount 写 (code/automatic create/update/activate/delete) | 写 | 否 | 治理写通道（动钱促销，高危） | high · 读 none |
| report/analytics 读 (sessions 已有；sales/orders/products ShopifyQL 缺) | 读 | 部分 | MCP 只读工具，直接加（注意独立站订单源 DWS 多 stale） | none |
| redirect 读/写 (urlRedirect create/update/delete) | 写 | 否 | 治理写通道；redirects 读先做 | low (create) · medium (delete) |
| theme/page/blog/menu 写 (themeFilesUpsert/publish、pages、nav) | 写 | 否 | 治理写通道（改 live 店面，blast radius 最大） | high (theme) · medium (page/menu) |
| webhook/bulkOp/shop/markets/translations (基础设施) | 混合 | 部分 | 读→MCP；写→治理 | high (markets/bulk) · medium (webhook/translations) · 读 none |

## 五、可以马上加的只读工具（零框架改动，按价值排）

1. `shopify.listCollections` / `getCollection` — 现在只能列集合内产品，列不出集合本身/ruleSet
2. `shopify.getProductById` / `searchProducts`（按 status/vendor/tag/created_at 搜）
3. `shopify.shopifyql`（sales/orders/products 数据集）— 已有 sessions，扩展只是换 query 字符串。⚠️ 独立站订单首选 DWS `dwa_od_shopify_sale_d`（T+0、仅件数），其余 DWS 独立站表 stale
4. `shopify.listInventoryLevels` / `listLocations` — 写库存的只读前置
5. `getMetafields` / `listPublications` / `suggestedRefund` / `listDraftOrders` / `listFulfillmentOrders` / `listDiscounts` — 各写通道的只读审计/预览前置

## 六、写操作开放顺序（都走治理通道，按"最安全/最有价值"）

1. **inventory_policy close**（continue→deny）— 已定第一个：medium、可逆、独立站有 dry-run/audit CLI 背书
2. **product tags add/remove** — low、非破坏（**不含** replace 全覆盖）；验证审批 UI
3. **variant price (bulk)** — high，但独立站有 per-SKU expected-price 安全闸 + 预览 job
4. **product status draft**（非 archived）— 可逆隐藏；archived 后置
5. **inventory setQuantities/adjust** — high（oversell），需 locationId + inventoryItemId，前置先上 levels/locations 只读
6. **collection add/remove、metafieldsSet** — medium，merch 编辑，可逆
7. **publish/unpublish、discount create/deactivate** — 触达客户/动钱，审批收紧
8. **refund/return、order cancel/edit、fulfillment** — high，最后开 + 最严审批
9. **theme files publish** — blast radius 最大，独立站无 CLI 背书，最后

## 七、数据源可靠性（独立站，阿里云 DWS everpretty）

- ✅ `dwa_od_shopify_sale_d` — 销量 by Account(EPSITExx)/style/sku，T+0 新鲜，**仅件数无 GMV**。口径：全 is_sale 求和、按 curated `style` 分组、过滤 `style NOT LIKE '%00000'`（YS00000 运费险/MH00000 福袋占 ~36% 件数）。已落地 `dws.siteTopStyles` + `dws.siteSlowMovers`。
- ❌ 独立站**退货率无可靠新鲜源**：`dwa_od_shopify_rmareturn_order_d` 只采 ~10% 物理退回，`dwa_pf_shopify_order_return_base_d` 量级对但冻结在 2025-12。**不做**独立站退货率工具，被问到直说"暂未接入"。

## 八、不做 / 已知陷阱

- 独立站退货率（无可靠新鲜源）。
- `productVariantsBulkUpdate` **不能**设库存量；库存量必须走专门 inventory mutation + location。
- REST 写端点废弃 → 写之前必补 GraphQL client（见第三节）。
