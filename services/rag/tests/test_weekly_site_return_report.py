from __future__ import annotations

import importlib.util
import sys
import types
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
            "coveredThrough": "2026-04-18",
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
    assert "2026-04-12 ~ 2026-04-18 (含)" in title
    assert "2026-04-12 ~ 2026-04-18 (含)" in markdown
    assert "2026-04-12 <= pay_time < 2026-04-19" not in markdown
    assert "低样本提示：DE salesQty=320, returnQty=64" in markdown
    assert "current退货率" in markdown
    assert "预测" not in markdown
    assert "dirtyWarehousePct=25.0%" in markdown


def test_inclusive_window_label_falls_back_to_window_end_minus_one_day():
    assert weekly_site.inclusive_window_label(
        {"windowStart": "2026-04-01", "windowEnd": "2026-05-01"}
    ) == "2026-04-01 ~ 2026-04-30 (含)"


def test_load_and_map_warehouse_names(tmp_path):
    path = tmp_path / "warehouse.json"
    path.write_text('{"CN_WAREHOUSE":"CN发货","YKD_USSC_WAREHOUSE":"谷仓发货"}', encoding="utf-8")

    warehouse_map = weekly_site.load_warehouse_map(path)

    assert weekly_site.map_warehouse_name("CN_WAREHOUSE", warehouse_map) == "CN发货"
    assert weekly_site.map_warehouse_name("YKD_USSC_WAREHOUSE", warehouse_map) == "谷仓发货"
    assert weekly_site.map_warehouse_name("WYT-UKTW", warehouse_map) == "未映射"
    assert weekly_site.map_warehouse_name("", warehouse_map) == "无仓库记录"
    assert weekly_site.map_warehouse_name(None, warehouse_map) == "无仓库记录"


def test_rollup_mapped_warehouse_rows_uses_fixed_order_and_dirty_return_share():
    rows = [
        {"rawWarehouseName": "CN_WAREHOUSE", "salesQty": 100, "returnQty": 10},
        {"rawWarehouseName": "WYT-UKTW", "salesQty": 50, "returnQty": 5},
        {"rawWarehouseName": None, "salesQty": 25, "returnQty": 5},
    ]
    warehouse_map = {"CN_WAREHOUSE": "CN发货"}

    out, dirty_pct = weekly_site.rollup_mapped_warehouse_rows(rows, warehouse_map)

    assert [row["warehouseName"] for row in out] == list(weekly_site.WAREHOUSE_DISPLAY_ORDER)
    by_name = {row["warehouseName"]: row for row in out}
    assert by_name["CN发货"]["returnShare"] == 0.5
    assert by_name["未映射"]["returnShare"] == 0.25
    assert by_name["无仓库记录"]["returnShare"] == 0.25
    assert dirty_pct == 0.5


def test_predict_restored_return_rate_beta_falls_back_from_low_style_sample():
    style_curve = {"returnedQty": 2, "pct_0_30": 0.8, "pct_31_45": 0.1, "pct_45plus": 0.1}
    type_curve = {"returnedQty": 20, "pct_0_30": 0.5, "pct_31_45": 0.25, "pct_45plus": 0.25}
    site_curve = {"returnedQty": 100, "pct_0_30": 0.6, "pct_31_45": 0.2, "pct_45plus": 0.2}

    result = weekly_site.predict_restored_return_rate_beta(
        0.10,
        30,
        style_curve,
        type_curve,
        site_curve,
        min_returned_qty=10,
    )

    assert result.curve_level == "styleType"
    assert result.low_confidence is True
    assert result.progress == 0.5
    assert result.rate == 0.2


def test_predict_restored_return_rate_beta_caps_and_uses_style_curve_when_sufficient():
    style_curve = {"returnedQty": 20, "pct_0_30": 0.2, "pct_31_45": 0.2, "pct_45plus": 0.6}

    result = weekly_site.predict_restored_return_rate_beta(
        0.60,
        10,
        style_curve,
        None,
        None,
        min_returned_qty=10,
    )

    assert result.curve_level == "style"
    assert result.low_confidence is False
    assert result.progress == 0.3
    assert result.rate == 0.95


def test_cohort_effective_age_days_uses_window_midpoint():
    metadata = {"asOfDate": "2026-06-15", "coveredThrough": "2026-05-31"}

    assert weekly_site.cohort_effective_age_days(metadata, "2026-05-01") == 30
    assert weekly_site.cohort_effective_age_days(metadata, None) is None
    assert weekly_site.cohort_effective_age_days({"asOfDate": "2026-06-15"}, "2026-05-01") is None


def test_timing_training_since_uses_as_of_date_minus_maturity_and_one_year():
    metadata = {"asOfDate": "2026-06-15"}

    assert weekly_site.timing_training_since(metadata, 120) == "2025-02-15"


def test_build_full_site_report_data_uses_mature_timing_window(monkeypatch):
    calls = []

    def fake_fetch_overall_summary(conn, account, since, until, maturity_days):
        return (
            {"rowCount": 1, "orderCount": 1, "salesQty": 100, "returnQty": 20, "returnRate": 0.2},
            {
                "asOfDate": "2026-06-15",
                "windowStart": "2026-05-01",
                "windowEnd": "2026-06-01",
                "coveredThrough": "2026-05-31",
                "maturityDays": 45,
            },
        )

    def fake_fetch_style(conn, account, since, until, maturity_days):
        assert (since, until, maturity_days) == ("2026-05-01", "2026-06-01", 45)
        return [{"styleCode": "EE00001", "salesQty": 100, "returnQty": 20}]

    def fake_fetch_timing(conn, account, since, until, maturity_days):
        calls.append((account, since, until, maturity_days))
        return (
            [
                {
                    "styleCode": "EE00001",
                    "returnedQty": 100,
                    "qty_0_30": 63,
                    "qty_31_45": 31.3,
                    "qty_45plus": 5.7,
                    "pct_0_30": 0.63,
                    "pct_31_45": 0.313,
                    "pct_45plus": 0.057,
                }
            ],
            {
                "asOfDate": "2026-06-15",
                "windowStart": "2025-02-15",
                "windowEnd": "2026-02-15",
                "coveredThrough": "2026-02-14",
                "maturityDays": 120,
            },
        )

    monkeypatch.setattr(weekly_site, "fetch_overall_summary", fake_fetch_overall_summary)
    monkeypatch.setattr(weekly_site, "fetch_site_return_rate_by_style", fake_fetch_style)
    monkeypatch.setattr(weekly_site, "fetch_site_return_timing_by_style_with_metadata", fake_fetch_timing)
    monkeypatch.setattr(weekly_site, "fetch_site_return_rate_by_order_units", lambda *args: [])
    monkeypatch.setattr(weekly_site, "fetch_site_return_rate_by_raw_warehouse", lambda *args: [])

    data = weekly_site.build_full_site_report_data(
        None,
        "US",
        weekly_site.WeekWindow(since="2026-05-01", until="2026-06-01", maturity_days=45),
        {"EE00001": weekly_site.StyleTag(style_type="迭代前", primary_category=None)},
        {},
        timing_maturity_days=120,
    )

    assert calls == [("EPSITEUS", "2025-02-15", None, 120)]
    assert data.timing_metadata["windowStart"] == "2025-02-15"
    subtotal = next(row for row in data.table2_rows if row["styleType"] == "迭代前" and row["isSubtotal"])
    assert subtotal["pct_45plus"] == 0.057


def test_build_full_table1_subtotal_style_type_curve_is_not_low_confidence():
    tags = {
        "EE00001": weekly_site.StyleTag(style_type="迭代前", primary_category=None),
        "EE00002": weekly_site.StyleTag(style_type="迭代前", primary_category=None),
    }
    style_rows = [{"styleCode": "EE00001", "salesQty": 100, "returnQty": 10}]
    mature_timing_rows = [
        {
            "styleCode": "EE00001",
            "returnedQty": 5,
            "qty_0_30": 5,
            "qty_31_45": 0,
            "qty_45plus": 0,
            "pct_0_30": 1.0,
            "pct_31_45": 0.0,
            "pct_45plus": 0.0,
        },
        {
            "styleCode": "EE00002",
            "returnedQty": 5,
            "qty_0_30": 5,
            "qty_31_45": 0,
            "qty_45plus": 0,
            "pct_0_30": 1.0,
            "pct_31_45": 0.0,
            "pct_45plus": 0.0,
        },
    ]

    rows = weekly_site.build_full_table1_rows(style_rows, mature_timing_rows, tags, 30)

    subtotal = next(row for row in rows if row["styleType"] == "迭代前" and row["isSubtotal"])
    style_detail = next(row for row in rows if row["styleCode"] == "EE00001" and not row["isSubtotal"])
    assert subtotal["predictionCurveLevel"] == "styleType"
    assert subtotal["lowConfidence"] is False
    assert style_detail["predictionCurveLevel"] == "styleType"
    assert style_detail["lowConfidence"] is True


def test_build_full_rows_use_business_style_type_order():
    tags = {
        "AA00001": weekly_site.StyleTag(style_type="迭代前", primary_category=None),
        "BB00001": weekly_site.StyleTag(style_type="迭代后", primary_category=None),
        "CC00001": weekly_site.StyleTag(style_type="新款", primary_category=None),
        "DD00001": weekly_site.StyleTag(style_type="pre-order", primary_category=None),
    }
    style_rows = [
        {"styleCode": "AA00001", "salesQty": 10, "returnQty": 1},
        {"styleCode": "BB00001", "salesQty": 10, "returnQty": 1},
        {"styleCode": "CC00001", "salesQty": 10, "returnQty": 1},
        {"styleCode": "DD00001", "salesQty": 10, "returnQty": 1},
        {"styleCode": "UNKNOWN", "salesQty": 10, "returnQty": 1},
    ]

    rows = weekly_site.build_full_table1_rows(style_rows, [], tags, 30)

    assert [row["styleType"] for row in rows if row["isSubtotal"]] == [
        "老款",
        "迭代前",
        "迭代后",
        "新款",
        "pre-order",
    ]
    assert rows[0]["styleType"] == "老款"
    assert rows[0]["styleCode"] == "小计"
    assert rows[1]["styleCode"] == "UNKNOWN"


def test_parse_args_full_defaults_false():
    args = weekly_site.parse_args([])

    assert args.full is False


def _sample_full_site_report_data() -> weekly_site.FullSiteReportData:
    return weekly_site.FullSiteReportData(
        site="US",
        account="EPSITEUS",
        metadata={
            "asOfDate": "2026-06-15",
            "windowStart": "2026-05-01",
            "windowEnd": "2026-06-01",
            "coveredThrough": "2026-05-31",
            "maturityDays": 45,
        },
        summary={"salesQty": 100, "returnQty": 20, "returnRate": 0.2},
        cohort_age_days=30,
        table1_rows=[
            {
                "styleType": "老款",
                "styleCode": "小计",
                "returnRate": 0.2,
                "predictedReturnRate": 0.25,
                "lowConfidence": False,
                "isSubtotal": True,
            },
            {
                "styleType": "老款",
                "styleCode": "EE00001",
                "returnRate": 0.1,
                "predictedReturnRate": 0.2,
                "lowConfidence": True,
                "isSubtotal": False,
            },
        ],
        table2_rows=[
            {
                "styleType": "老款",
                "styleCode": "小计",
                "pct_0_30": 0.63,
                "pct_31_45": 0.313,
                "pct_45plus": 0.057,
                "isSubtotal": True,
            }
        ],
        order_unit_rows=[
            {"unitsBucket": "1", "returnRate": 0.1},
            {"unitsBucket": "2", "returnRate": 0.2},
            {"unitsBucket": "3", "returnRate": 0.3},
            {"unitsBucket": "4", "returnRate": 0.4},
            {"unitsBucket": "5+", "returnRate": 0.5},
        ],
        warehouse_rows=[
            {
                "warehouseName": label,
                "returnShare": 0.125,
                "returnRate": 0.1,
            }
            for label in weekly_site.WAREHOUSE_DISPLAY_ORDER
        ],
        dirty_warehouse_pct=0.25,
        timing_metadata={
            "windowStart": "2025-02-15",
            "windowEnd": "2026-02-15",
            "coveredThrough": "2026-02-14",
            "maturityDays": 120,
        },
    )


def test_render_full_markdown_report_matches_business_template():
    site = _sample_full_site_report_data()
    data = weekly_site.FullReportData(
        since="2026-05-01",
        until="2026-06-01",
        maturity_days=45,
        timing_maturity_days=120,
        sites=[site],
    )

    _title, markdown = weekly_site.render_full_markdown_report(data)

    assert "| 款式类型 | style | 订单销售日期 | 退款日期 | 当前还原退款率 | 预测还原退款率 |" in markdown
    assert "| 老款 | 小计 | 2026-05-01 ~ 2026-05-31 | 截至 2026-06-15 | 20.0% | 25.0% |" in markdown
    assert "| 老款 | EE00001 (lowConfidence) | 2026-05-01 ~ 2026-05-31 | 截至 2026-06-15 | 10.0% | 20.0% |" in markdown
    assert "| 款式类型 | style | 30天退货占比 | 45天退货占比 | 45天以上退货占比 |" in markdown
    assert "| 订单 | 订单销售日期 | 退款日期 | 当前还原退款率 |" in markdown
    assert "| 1件 | 2026-05-01 ~ 2026-05-31 | 截至 2026-06-15 | 10.0% |" in markdown
    assert "| 5件以上 | 2026-05-01 ~ 2026-05-31 | 截至 2026-06-15 | 50.0% |" in markdown
    assert "| 发货仓库 | 退货占比 | 当前还原退款率 |" in markdown
    assert "dirtyWarehousePct=25.0%" in markdown
    assert "预测还原退款率(beta)：当前还原退款率" in markdown
    assert "预测还原退款率(beta) |" not in markdown
    assert "| 订单件数 |" not in markdown
    assert "| 发货仓 |" not in markdown


def test_export_full_report_xlsx_matches_business_template(tmp_path):
    class FakeCell:
        def __init__(self, row, column, value=None):
            self.row = row
            self.column = column
            self.value = value
            self.font = None
            self.fill = None
            self.number_format = None
            self.column_letter = chr(ord("A") + column - 1)

    class FakeWorksheet:
        def __init__(self, title):
            self.title = title
            self._cells = {}
            self.max_row = 0
            self.max_column = 0
            self.column_dimensions = {}

        def cell(self, row, column, value=None):
            key = (row, column)
            if key not in self._cells:
                self._cells[key] = FakeCell(row, column)
            cell = self._cells[key]
            if value is not None:
                cell.value = value
            self.max_row = max(self.max_row, row)
            self.max_column = max(self.max_column, column)
            self.column_dimensions.setdefault(cell.column_letter, types.SimpleNamespace(width=None))
            return cell

        @property
        def columns(self):
            return [
                [self.cell(row_idx, col_idx) for row_idx in range(1, self.max_row + 1)]
                for col_idx in range(1, self.max_column + 1)
            ]

        def values(self):
            rows = []
            for row_idx in range(1, self.max_row + 1):
                values = [self.cell(row_idx, col_idx).value for col_idx in range(1, self.max_column + 1)]
                while values and values[-1] is None:
                    values.pop()
                rows.append(tuple(values))
            return rows

    class FakeWorkbook:
        last = None

        def __init__(self):
            FakeWorkbook.last = self
            self.active = FakeWorksheet("Sheet")
            self.sheets = [self.active]

        def remove(self, ws):
            self.sheets.remove(ws)

        def create_sheet(self, title):
            ws = FakeWorksheet(title)
            self.sheets.append(ws)
            return ws

        def save(self, path):
            self.saved_path = path

    fake_openpyxl = types.SimpleNamespace(Workbook=FakeWorkbook)
    fake_styles = types.SimpleNamespace(
        Font=lambda **kwargs: ("Font", kwargs),
        PatternFill=lambda *args, **kwargs: ("PatternFill", args, kwargs),
    )
    monkeypatch_modules = {
        "openpyxl": fake_openpyxl,
        "openpyxl.styles": fake_styles,
    }
    original_modules = {name: sys.modules.get(name) for name in monkeypatch_modules}
    sys.modules.update(monkeypatch_modules)

    data = weekly_site.FullReportData(
        since="2026-05-01",
        until="2026-06-01",
        maturity_days=45,
        timing_maturity_days=120,
        sites=[_sample_full_site_report_data()],
    )
    path = tmp_path / "full.xlsx"

    try:
        weekly_site.export_full_report_xlsx(data, path)
    finally:
        for name, module in original_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    workbook = FakeWorkbook.last
    assert workbook is not None
    assert workbook.saved_path == path
    ws = workbook.sheets[0]
    rows = ws.values()

    assert ("款式类型", "style", "订单销售日期", "退款日期", "当前还原退款率", "预测还原退款率") in rows
    table1_header_idx = rows.index(("款式类型", "style", "订单销售日期", "退款日期", "当前还原退款率", "预测还原退款率"))
    assert rows[table1_header_idx + 1][:6] == ("老款", "小计", "2026-05-01 ~ 2026-05-31", "截至 2026-06-15", 0.2, 0.25)
    assert rows[table1_header_idx + 2][:6] == (
        "老款",
        "EE00001 (lowConfidence)",
        "2026-05-01 ~ 2026-05-31",
        "截至 2026-06-15",
        0.1,
        0.2,
    )
    assert ("款式类型", "style", "30天退货占比", "45天退货占比", "45天以上退货占比") in rows
    assert ("订单", "订单销售日期", "退款日期", "当前还原退款率") in rows
    order_header_idx = rows.index(("订单", "订单销售日期", "退款日期", "当前还原退款率"))
    assert rows[order_header_idx + 1][:4] == ("1件", "2026-05-01 ~ 2026-05-31", "截至 2026-06-15", 0.1)
    assert rows[order_header_idx + 5][:4] == ("5件以上", "2026-05-01 ~ 2026-05-31", "截至 2026-06-15", 0.5)
    assert ("发货仓库", "退货占比", "当前还原退款率") in rows
    warehouse_header_idx = rows.index(("发货仓库", "退货占比", "当前还原退款率"))
    assert [rows[warehouse_header_idx + idx][0] for idx in range(1, 9)] == list(weekly_site.WAREHOUSE_DISPLAY_ORDER)


def test_render_full_markdown_report_describes_timing_training_window():
    site = weekly_site.FullSiteReportData(
        site="US",
        account="EPSITEUS",
        metadata={
            "asOfDate": "2026-06-15",
            "windowStart": "2026-05-01",
            "windowEnd": "2026-06-01",
            "coveredThrough": "2026-05-31",
            "maturityDays": 45,
        },
        summary={"salesQty": 100, "returnQty": 20, "returnRate": 0.2},
        cohort_age_days=30,
        table1_rows=[],
        table2_rows=[],
        order_unit_rows=[],
        warehouse_rows=[],
        dirty_warehouse_pct=0.0,
        timing_metadata={
            "windowStart": "2025-02-15",
            "windowEnd": "2026-02-15",
            "coveredThrough": "2026-02-14",
            "maturityDays": 120,
        },
    )
    data = weekly_site.FullReportData(
        since="2026-05-01",
        until="2026-06-01",
        maturity_days=45,
        timing_maturity_days=120,
        sites=[site],
    )

    _title, markdown = weekly_site.render_full_markdown_report(data)

    note = "表二/预测曲线来自成熟训练窗口 [2025-02-15 ~ 2026-02-15)（覆盖至 2026-02-14 含），maturity=120；不是展示窗口。"
    assert f"- {note}" in markdown
    assert f"> {note}" in markdown
