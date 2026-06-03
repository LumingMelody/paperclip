from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "weekly_site_return_report.py"
SPEC = importlib.util.spec_from_file_location("weekly_site_return_report", SCRIPT_PATH)
weekly_site = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["weekly_site_return_report"] = weekly_site
SPEC.loader.exec_module(weekly_site)


def test_rollup_style_type_rates_maps_missing_styles_to_old_uncategorized():
    tags = {
        "EE00001": weekly_site.StyleTag(style_type="迭代后", primary_category="EE"),
        "EE00002": weekly_site.StyleTag(style_type="新款", primary_category="EE"),
    }
    rows = [
        {"styleCode": "EE00001", "salesQty": 100, "returnQty": 20},
        {"styleCode": "EE00002", "salesQty": 50, "returnQty": 5},
        {"styleCode": "UNKNOWN", "salesQty": 25, "returnQty": 10},
    ]

    out = weekly_site.rollup_style_type_rates(rows, tags)
    by_type = {row["styleType"]: row for row in out}

    assert by_type["迭代后"]["styleCount"] == 1
    assert by_type["迭代后"]["returnRate"] == 0.2
    assert by_type["迭代后"]["salesShare"] == 0.5714
    assert by_type["新款"]["styleCount"] == 1
    assert by_type["新款"]["returnRate"] == 0.1
    assert by_type["老款(未分类)"]["styleCount"] == 1
    assert by_type["老款(未分类)"]["returnRate"] == 0.4


def test_rollup_timing_by_style_type_uses_returned_quantity_denominator():
    tags = {"EE00001": weekly_site.StyleTag(style_type="迭代前", primary_category=None)}
    rows = [
        {
            "styleCode": "EE00001",
            "returnedQty": 10,
            "qty_0_30": 6,
            "qty_31_45": 3,
            "qty_45plus": 1,
        },
        {
            "styleCode": "MISSING",
            "returnedQty": 5,
            "qty_0_30": 1,
            "qty_31_45": 1,
            "qty_45plus": 3,
        },
    ]

    out = weekly_site.rollup_timing_by_style_type(rows, tags)
    by_type = {row["styleType"]: row for row in out}

    assert by_type["迭代前"]["pct_0_30"] == 0.6
    assert by_type["迭代前"]["pct_31_45"] == 0.3
    assert by_type["迭代前"]["pct_45plus"] == 0.1
    assert by_type["老款(未分类)"]["pct_0_30"] == 0.2
    assert by_type["老款(未分类)"]["pct_45plus"] == 0.6


def test_render_markdown_report_marks_de_low_sample_and_current_only():
    site = weekly_site.SiteReportData(
        site="DE",
        account="EPSITEDE",
        metadata={
            "asOfDate": "2026-06-03",
            "windowStart": "2026-04-12",
            "windowEnd": "2026-04-19",
            "maturityDays": 45,
        },
        summary={"rowCount": 300, "orderCount": 120, "salesQty": 320, "returnQty": 64, "returnRate": 0.2},
        style_type_rows=[
            {
                "styleType": style_type,
                "styleCount": 0,
                "salesQty": 0,
                "salesShare": None,
                "returnQty": 0,
                "returnRate": None,
            }
            for style_type in weekly_site.STYLE_TYPE_ORDER
        ],
        top_styles=[],
        timing_rows=[
            {"styleType": style_type, "returnedQty": 0, "pct_0_30": None, "pct_31_45": None, "pct_45plus": None}
            for style_type in weekly_site.STYLE_TYPE_ORDER
        ],
        order_unit_rows=[],
        warehouse_rows=[],
        dirty_warehouse_pct=0.25,
    )
    data = weekly_site.ReportData(since="2026-04-12", until=None, maturity_days=45, sites=[site])

    title, markdown = weekly_site.render_markdown_report(data)

    assert "独立站 Shopify 退货率周报" in title
    assert "低样本提示：DE salesQty=320, returnQty=64" in markdown
    assert "current退货率" in markdown
    assert "预测" not in markdown
    assert "dirtyWarehousePct=25.0%" in markdown
