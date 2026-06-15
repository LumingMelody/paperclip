#!/usr/bin/env python3
"""BU 级还原退货率预测（纠正版口径）。

修复旧版「等时间月指数平滑」的系统性低估：
- 只用成熟销售月做训练（默认 2026-02/03/04，排除右删失的 5/6 月）。
- 店预测率 = 成熟月池化件数退货率 = Σrf / Σqty（天然按销量加权，压低低量旧月）。
- BU 汇总用「预测目标月（5 月）实际销量结构」加权，不与成熟历史率混列。
- Amazon 走 dws_od_amazon_refund_rate_d（yearmouth 销售月、件数）；
  独立站走 dm_od_shopify_resreturn_d（pay_time cohort、件数）。
- BU 口径 = ods_sp_me_platform_account_m.financePlatform（performance_fir）。

成熟阈值依据：Amazon 退款时滞 ~60 天（3 月 cohort≈4 月 cohort 已稳定；
数仓 dwa_sales_predict_refund_d 逐日累计也封顶 60 天）。

只读分析脚本，不写库。凭据从 tool-secrets.json 读。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pymysql

SECRETS = Path("/Users/melodylu/.paperclip/tool-secrets.json")
MATURE_MONTHS = ("2026-02", "2026-03", "2026-04")  # 成熟训练月
TARGET_MONTH = "2026-05"  # 预测目标 / 加权销量月
SHOPIFY_ACCOUNTS = ("EPSITEUS", "EPSITEUK", "EPSITEFR", "EPSITEDE", "EPSITEPlus", "EPSITEAU")


def _dws_conn():
    s = json.loads(SECRETS.read_text(encoding="utf-8"))
    dws = list(s["companies"].values())[0]["dws"]
    return pymysql.connect(
        host=dws["host"], port=int(dws.get("port") or 3306), user=dws["user"],
        password=dws["password"], database=dws["database"], charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor, connect_timeout=8, read_timeout=60,
    )


def load_bu_map(conn) -> dict[str, dict]:
    """userAccount -> {accountId, bu(financePlatform), platform}."""
    sql = (
        "SELECT userAccount, accountId, financePlatform AS bu, platform "
        "FROM ods_sp_me_platform_account_m "
        "WHERE financePlatform IS NOT NULL AND financePlatform <> ''"
    )
    out: dict[str, dict] = {}
    with conn.cursor() as c:
        c.execute(sql)
        for r in c.fetchall():
            out[r["userAccount"]] = {
                "accountId": r["accountId"],
                "bu": str(r["bu"]).strip(),
                "platform": (r["platform"] or "").strip().lower(),
            }
    return out


def amazon_store_stats(conn, account_id: int) -> dict:
    """成熟月 Σqty/Σrf（件数）+ 5 月实销 qty。"""
    placeholders = ",".join(["%s"] * len(MATURE_MONTHS))
    with conn.cursor() as c:
        c.execute(
            f"""SELECT CAST(COALESCE(SUM(quantity),0) AS SIGNED) qty,
                       CAST(COALESCE(SUM(rf_quantity),0) AS SIGNED) rf
                FROM dws_od_amazon_refund_rate_d
                WHERE accountId=%s AND yearmouth IN ({placeholders})""",
            (account_id, *MATURE_MONTHS),
        )
        m = c.fetchone()
        c.execute(
            """SELECT CAST(COALESCE(SUM(quantity),0) AS SIGNED) qty
               FROM dws_od_amazon_refund_rate_d
               WHERE accountId=%s AND yearmouth=%s""",
            (account_id, TARGET_MONTH),
        )
        t = c.fetchone()
    return {"mature_qty": int(m["qty"]), "mature_rf": int(m["rf"]), "may_sales": int(t["qty"])}


def shopify_store_stats(conn, account: str) -> dict:
    """成熟月 Σqty/Σrf（件数退货率，从 resreturn 自洽算）+ 5 月实销 qty。

    口径分离：退货率分子/分母都来自 dm_od_shopify_resreturn_d（退货率自洽来源，
    但它只覆盖 ~68% 销量）；BU 权重用的真实 5 月销量来自权威销量表
    dwa_od_shopify_sale_d（SUM(qty) 全求和，is_sale=1 only 会低估）。
    """
    since = MATURE_MONTHS[0] + "-01"
    mature_until = "2026-05-01"   # pay_time < ，覆盖 2-4 月
    with conn.cursor() as c:
        c.execute(
            """SELECT CAST(COALESCE(SUM(quantity),0) AS SIGNED) qty,
                      CAST(COALESCE(SUM(COALESCE(return_quantity,0)),0) AS SIGNED) rf
               FROM dm_od_shopify_resreturn_d
               WHERE account=%s AND pay_time>=%s AND pay_time<%s""",
            (account, since, mature_until),
        )
        m = c.fetchone()
        c.execute(
            """SELECT CAST(COALESCE(SUM(qty),0) AS SIGNED) qty
               FROM dwa_od_shopify_sale_d
               WHERE Account=%s AND statistic_time_local>='2026-05-01'
                 AND statistic_time_local<'2026-06-01'""",
            (account,),
        )
        t = c.fetchone()
    return {"mature_qty": int(m["qty"]), "mature_rf": int(m["rf"]), "may_sales": int(t["qty"])}


def main() -> int:
    conn = _dws_conn()
    bu_map = load_bu_map(conn)

    stores: list[dict] = []
    # Amazon: 所有 financePlatform 店里 platform 含 amazon 的
    for acc, info in bu_map.items():
        if "amazon" not in info["platform"]:
            continue
        if info["accountId"] is None:
            continue
        st = amazon_store_stats(conn, info["accountId"])
        if st["may_sales"] <= 0 and st["mature_qty"] <= 0:
            continue
        stores.append({"store": acc, "bu": info["bu"], "platform": "amazon", **st})
    # Shopify 独立站
    for acc in SHOPIFY_ACCOUNTS:
        info = bu_map.get(acc)
        if not info:
            continue
        st = shopify_store_stats(conn, acc)
        if st["may_sales"] <= 0 and st["mature_qty"] <= 0:
            continue
        stores.append({"store": acc, "bu": info["bu"], "platform": "shopify", **st})
    conn.close()

    for s in stores:
        s["pred_rate"] = (s["mature_rf"] / s["mature_qty"]) if s["mature_qty"] > 0 else None

    # BU 汇总：按 5 月实销加权店预测率
    bus: dict[str, dict] = {}
    for s in stores:
        b = bus.setdefault(s["bu"], {"may_sales": 0, "weighted": 0.0, "stores": []})
        b["stores"].append(s)
        if s["pred_rate"] is not None and s["may_sales"] > 0:
            b["may_sales"] += s["may_sales"]
            b["weighted"] += s["may_sales"] * s["pred_rate"]
    for b in bus.values():
        b["bu_rate"] = (b["weighted"] / b["may_sales"]) if b["may_sales"] > 0 else None

    print(f"# BU 还原退货率预测（纠正版 · 成熟月 {'/'.join(MATURE_MONTHS)} 训练，{TARGET_MONTH} 销量加权）\n")
    print("## BU 级")
    print("| BU | 5月销量 | 预测还原退货率 |")
    print("|----|--------:|------:|")
    for bu in sorted(bus):
        b = bus[bu]
        rate = f"{b['bu_rate']*100:.2f}%" if b["bu_rate"] is not None else "—"
        print(f"| {bu} | {b['may_sales']:,} | {rate} |")

    print("\n## 店铺明细")
    print("| 店铺 | BU | 平台 | 5月销量 | 成熟月件数 | 店预测率 |")
    print("|------|----|------|--------:|--------:|------:|")
    for s in sorted(stores, key=lambda x: (x["bu"], -x["may_sales"])):
        pr = f"{s['pred_rate']*100:.1f}%" if s["pred_rate"] is not None else "—"
        print(f"| {s['store']} | {s['bu']} | {s['platform']} | {s['may_sales']:,} | {s['mature_qty']:,} | {pr} |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
