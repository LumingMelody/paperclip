#!/usr/bin/env python3
"""Two-SKU full-view analysis — EG02084 (2088) vs EE02559 (2559).

Pulls Amazon sales+returns from DWS prod and Shopify from OMS, emits a single
markdown report at docs/sku-analysis/<date>-EG02084-vs-EE02559.md.

One-off analysis, not a reusable tool. Run: python3 _analyze_sku_full_view.py
"""
from __future__ import annotations
import argparse
from datetime import date
import pymysql

OMS = dict(host='192.168.0.227', port=3306, user='root',
           password='@@OMSWMStms2025##', database='dev_everpretty_oms',
           charset='utf8mb4', connect_timeout=8)
DWS = dict(host='rm-bp1dm282ayh5203tngo.mysql.rds.aliyuncs.com', port=3306,
           user='DW_AI_READ_ONLY', password='epai@123456',
           database='everpretty', charset='utf8mb4', connect_timeout=8)

STYLES = [
    {"label": "2088 系列", "prefix": "EG02084"},
    {"label": "2559 系列", "prefix": "EE02559"},
]


def q(conn_conf, sql, params=None):
    conn = pymysql.connect(**conn_conf)
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.execute(sql, params or {})
            return cur.fetchall()
    finally:
        conn.close()


def fmt_int(v):
    return f"{int(v):,}" if v is not None else "—"


def fmt_money(v):
    return f"{float(v):,.2f}" if v is not None else "—"


def fmt_pct(num, den, decimals=2):
    if not den or den == 0:
        return "—"
    return f"{(float(num) / float(den)) * 100:.{decimals}f}%"


def analyze(style):
    prefix = style["prefix"]
    out = []
    out.append(f"## {style['label']} — `{prefix}*`\n")

    # ------------------------------------------------------------------
    # 1. Amazon sales + return totals (DWS, prod-complete)
    # ------------------------------------------------------------------
    amz_total = q(DWS, """
        SELECT
            COUNT(DISTINCT amazon_order_id) AS orders,
            COUNT(*) AS lineRows,
            CAST(COALESCE(SUM(quantity),0) AS UNSIGNED) AS soldUnits,
            CAST(COALESCE(SUM(rf_quantity),0) AS UNSIGNED) AS rfUnits,
            MIN(check_date) AS firstDate,
            MAX(check_date) AS lastDate
        FROM dws_od_amazon_refund_rate_d
        WHERE seller_sku LIKE %(p)s
    """, {'p': prefix + '%'})[0]

    # ------------------------------------------------------------------
    # 2. Shopify sales (OMS prod-complete)
    # ------------------------------------------------------------------
    shop_by_currency = q(OMS, """
        SELECT
            o.currency,
            COUNT(DISTINCT o.id) AS orders,
            CAST(COALESCE(SUM(i.quantity),0) AS UNSIGNED) AS units,
            CAST(COALESCE(SUM(i.price * i.quantity),0) AS DECIMAL(20,2)) AS gmv
        FROM shopify_order_item i
        JOIN shopify_order o ON CAST(o.shopify_order_id AS UNSIGNED) = i.shopify_order_id
        WHERE i.sku LIKE %(p)s
          AND o.cancelled_at IS NULL
        GROUP BY o.currency
        ORDER BY gmv DESC
    """, {'p': prefix + '%'})

    shop_total_units = sum(int(r['units']) for r in shop_by_currency)
    shop_total_orders = sum(int(r['orders']) for r in shop_by_currency)

    # ------------------------------------------------------------------
    # 3. Sales overview section
    # ------------------------------------------------------------------
    out.append("### 1. 销售总览 (cumulative all-time)\n")
    out.append("**Amazon (DWS prod)**\n")
    out.append("| 指标 | 值 |")
    out.append("|---|---:|")
    out.append(f"| 涉及订单 | {fmt_int(amz_total['orders'])} |")
    out.append(f"| 销售件数 | **{fmt_int(amz_total['soldUnits'])}** |")
    out.append(f"| 退货件数 | {fmt_int(amz_total['rfUnits'])} |")
    out.append(f"| 数据起始 | {amz_total['firstDate']} → {amz_total['lastDate']} |")
    out.append("")
    out.append("**Shopify 独立站 (OMS, by currency)**\n")
    if shop_by_currency:
        out.append("| 币种 | 订单 | 件数 | GMV |")
        out.append("|---|---:|---:|---:|")
        for r in shop_by_currency:
            out.append(f"| {r['currency'] or '—'} | {fmt_int(r['orders'])} | {fmt_int(r['units'])} | {fmt_money(r['gmv'])} |")
        out.append(f"| **合计件数** |  | **{fmt_int(shop_total_units)}** |  |")
    else:
        out.append("_no Shopify rows_")
    out.append("")

    # ------------------------------------------------------------------
    # 4. Return rate (Amazon — DWS), reason breakdown
    # ------------------------------------------------------------------
    reasons = q(DWS, """
        SELECT
            COALESCE(NULLIF(return_reason,''), '(unknown)') AS reason,
            COUNT(*) AS cnt,
            CAST(SUM(quantity) AS UNSIGNED) AS units
        FROM dm_allretrun_analysis_d
        WHERE sku LIKE %(p)s
        GROUP BY reason
        ORDER BY units DESC LIMIT 10
    """, {'p': prefix + '%'})

    out.append("### 2. 退货率 (Amazon, 单款还原)\n")
    out.append("| 维度 | 值 |")
    out.append("|---|---:|")
    out.append(f"| Amazon 销售件 (DWS) | {fmt_int(amz_total['soldUnits'])} |")
    out.append(f"| Amazon 退货件 (DWS rf_quantity) | {fmt_int(amz_total['rfUnits'])} |")
    out.append(f"| **Amazon 退货率** | **{fmt_pct(amz_total['rfUnits'], amz_total['soldUnits'])}** |")
    out.append("")
    out.append("**退货原因 Top 10**\n")
    out.append("| Reason | 行数 | 件数 |")
    out.append("|---|---:|---:|")
    for r in reasons:
        out.append(f"| {r['reason']} | {fmt_int(r['cnt'])} | {fmt_int(r['units'])} |")
    out.append("")
    out.append("> 注：Shopify 退货数据当前没有结构化数据源（financial_status='refunded' 是近似但 line-item 级精度差），所以退货率口径只覆盖 Amazon。\n")

    # ------------------------------------------------------------------
    # 5. Top 20 variants by combined sales (Amazon sold + Shopify units)
    # ------------------------------------------------------------------
    amz_variants = q(DWS, """
        SELECT seller_sku AS sku, CAST(SUM(quantity) AS UNSIGNED) AS sold,
               CAST(SUM(rf_quantity) AS UNSIGNED) AS refunded
        FROM dws_od_amazon_refund_rate_d
        WHERE seller_sku LIKE %(p)s
        GROUP BY seller_sku
        ORDER BY sold DESC LIMIT 20
    """, {'p': prefix + '%'})

    out.append("### 3. Top 20 变体 (按 Amazon 销售件数)\n")
    out.append("| 变体 SKU | Amazon 售 | Amazon 退 | 退货率 |")
    out.append("|---|---:|---:|---:|")
    for r in amz_variants:
        out.append(f"| `{r['sku']}` | {fmt_int(r['sold'])} | {fmt_int(r['refunded'])} | {fmt_pct(r['refunded'], r['sold'])} |")
    out.append("")

    # ------------------------------------------------------------------
    # 6. Repurchase (Shopify, OMS)
    # ------------------------------------------------------------------
    repurch = q(OMS, """
        SELECT
            o.customer_email AS email,
            COUNT(DISTINCT o.id) AS orders,
            CAST(SUM(i.quantity) AS UNSIGNED) AS units,
            CAST(SUM(i.price * i.quantity) AS DECIMAL(20,2)) AS gmv,
            MAX(o.currency) AS currency,
            MIN(o.order_created_at) AS firstOrder,
            MAX(o.order_created_at) AS lastOrder
        FROM shopify_order_item i
        JOIN shopify_order o ON CAST(o.shopify_order_id AS UNSIGNED) = i.shopify_order_id
        WHERE i.sku LIKE %(p)s
          AND o.cancelled_at IS NULL
          AND o.customer_email IS NOT NULL AND o.customer_email != ''
        GROUP BY o.customer_email
        HAVING orders >= 2
        ORDER BY orders DESC, gmv DESC
        LIMIT 20
    """, {'p': prefix + '%'})

    out.append("### 4. Shopify 复购 (>=2 单, Top 20)\n")
    out.append(f"匹配复购客户: **{len(repurch)}** 人")
    if repurch:
        out.append("")
        out.append("| 客户 (脱敏) | 订单 | 件 | GMV | 币 | 首单 | 最近 |")
        out.append("|---|---:|---:|---:|---|---|---|")
        for r in repurch:
            em = r['email']
            if '@' in em:
                a, b = em.split('@', 1)
                em = a[:3] + '***@' + b
            out.append(f"| {em} | {fmt_int(r['orders'])} | {fmt_int(r['units'])} | "
                       f"{fmt_money(r['gmv'])} | {r['currency'] or '—'} | "
                       f"{str(r['firstOrder'])[:10]} | {str(r['lastOrder'])[:10]} |")
    out.append("")

    # ------------------------------------------------------------------
    # 7. Inventory
    # ------------------------------------------------------------------
    inv = q(OMS, """
        SELECT
            w.warehouse_type AS wtype,
            w.country_code AS country,
            COUNT(DISTINCT i.sku_code) AS skuCount,
            CAST(SUM(i.available_quantity) AS UNSIGNED) AS available,
            CAST(SUM(i.physical_quantity) AS UNSIGNED) AS physical,
            CAST(SUM(i.transit_in_quantity) AS UNSIGNED) AS transitIn
        FROM inventory i
        JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.sku_code LIKE %(p)s AND i.deleted = 0 AND w.is_active = 1
        GROUP BY w.warehouse_type, w.country_code
        ORDER BY available DESC
    """, {'p': prefix + '%'})

    out.append("### 5. 当前库存 (OMS snapshot)\n")
    if inv:
        out.append("| 仓类型 | 国家 | SKU 数 | 可用 | 实物 | 在途 |")
        out.append("|---|---|---:|---:|---:|---:|")
        total_avail = 0
        for r in inv:
            total_avail += int(r['available'] or 0)
            out.append(f"| {r['wtype'] or '—'} | {r['country'] or '—'} | "
                       f"{fmt_int(r['skuCount'])} | {fmt_int(r['available'])} | "
                       f"{fmt_int(r['physical'])} | {fmt_int(r['transitIn'])} |")
        out.append(f"| **合计可用** |  |  | **{fmt_int(total_avail)}** |  |  |")
    out.append("")

    # ------------------------------------------------------------------
    # 8. Product iteration proxy
    # ------------------------------------------------------------------
    pi = q(OMS, """
        SELECT
            COUNT(DISTINCT sku) AS skuCount,
            SUM(CASE WHEN is_delete=0 THEN 1 ELSE 0 END) AS activeCount
        FROM sku_base
        WHERE sku LIKE %(p)s
    """, {'p': prefix + '%'})[0]

    out.append("### 6. 产品前世今生 (代理指标)\n")
    out.append(f"- **变体 SKU 总数 (sku_base)**: {fmt_int(pi['skuCount'])}（未删除 {fmt_int(pi['activeCount'])}）")
    out.append(f"- **Amazon 数据起止 (DWS)**: {amz_total['firstDate']} → {amz_total['lastDate']}")
    out.append(f"- ⚠️ 完整 PLM / 工厂版本变更**未接入**；上线 / 改款 / 迭代时间点目前没有结构化数据源。")
    out.append("")

    summary = dict(
        prefix=prefix,
        amzSold=int(amz_total['soldUnits']),
        amzRefunded=int(amz_total['rfUnits']),
        shopUnits=shop_total_units,
        shopOrders=shop_total_orders,
        repurchase=len(repurch),
    )
    return "\n".join(out), summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=f"docs/sku-analysis/{date.today().isoformat()}-EG02084-vs-EE02559.md")
    args = parser.parse_args()

    parts = []
    parts.append("# 双 SKU 全平台对比 — EG02084 (2088) vs EE02559 (2559)\n")
    parts.append(f"**生成时间**: {date.today().isoformat()}")
    parts.append("**数据源**:")
    parts.append("- Amazon 销售 + 退货: DWS prod (`dws_od_amazon_refund_rate_d` for both 售/退, `dm_allretrun_analysis_d` for reason)")
    parts.append("- Shopify 销售 / 复购: OMS prod (shopify_order × shopify_order_item)")
    parts.append("- 库存: OMS prod (inventory × warehouses)")
    parts.append("")
    parts.append("**未覆盖**: Shopify 退货 / 页面 / 转化率 / Amazon 广告 ROI (LAN 不通) / 利润 (无 COGS) / 唯一码 / PLM")
    parts.append("")
    parts.append("---\n")

    summaries = []
    for style in STYLES:
        md, sm = analyze(style)
        parts.append(md)
        parts.append("---\n")
        summaries.append(sm)

    # Comparison summary
    parts.append("## 两款对比一表\n")
    parts.append("| 指标 | EG02084 (2088) | EE02559 (2559) |")
    parts.append("|---|---:|---:|")
    parts.append(f"| Amazon 销售件 | {fmt_int(summaries[0]['amzSold'])} | {fmt_int(summaries[1]['amzSold'])} |")
    parts.append(f"| Amazon 退货件 | {fmt_int(summaries[0]['amzRefunded'])} | {fmt_int(summaries[1]['amzRefunded'])} |")
    parts.append(f"| **Amazon 退货率** | **{fmt_pct(summaries[0]['amzRefunded'], summaries[0]['amzSold'])}** | **{fmt_pct(summaries[1]['amzRefunded'], summaries[1]['amzSold'])}** |")
    parts.append(f"| Shopify 订单 | {fmt_int(summaries[0]['shopOrders'])} | {fmt_int(summaries[1]['shopOrders'])} |")
    parts.append(f"| Shopify 件数 | {fmt_int(summaries[0]['shopUnits'])} | {fmt_int(summaries[1]['shopUnits'])} |")
    parts.append(f"| Shopify 复购客户 | {fmt_int(summaries[0]['repurchase'])} | {fmt_int(summaries[1]['repurchase'])} |")
    parts.append("")

    parts.append("---\n")
    parts.append("## 数据缺口说明\n")
    parts.append("| 项 | 状态 | 补法 |")
    parts.append("|---|---|---|")
    parts.append("| Shopify 退货率 | ❌ | OMS 无结构化退货表；可从 `shopify_order.financial_status='refunded'` 近似 |")
    parts.append("| Shopify 页面/转化率 | ❌ | 接 Shopify Analytics API 或 GA / Plausible |")
    parts.append("| Amazon 广告 / ROI | ⚠️ | `T_AM_OriginalAdReport_*` 在 LAN-only SQL Server，当前网络不通 |")
    parts.append("| 利润额/率 | ❌ | 需提供 COGS 表 (per-SKU 成本 + 物流) |")
    parts.append("| 唯一码追踪 | ❌ | 工厂 QR / 序列号系统未接入 |")
    parts.append("| 完整 PLM | ⚠️ | sku_base 无时间字段；接 1688 / 工厂端 PLM 可补 |")

    text = "\n".join(parts)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"Wrote {args.out} ({len(text)} chars)")


if __name__ == "__main__":
    main()
