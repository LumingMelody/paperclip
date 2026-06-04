from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import httpx
import pytest
import respx


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "weekly_return_report.py"
SPEC = importlib.util.spec_from_file_location("weekly_return_report", SCRIPT_PATH)
weekly = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["weekly_return_report"] = weekly
SPEC.loader.exec_module(weekly)


def test_format_wow_handles_normal_and_zero_denominator_edges():
    assert weekly.format_wow(12, 10) == "↑ 20.0%"
    assert weekly.format_wow(5, 10) == "↓ 50.0%"
    assert weekly.format_wow(0, 0) == "→ 0.0%"
    assert weekly.format_wow(4, 0) == "↑ ∞%"
    assert weekly.is_spike(16, 10) is True
    assert weekly.is_spike(15, 10) is False
    assert weekly.is_spike(1, 0) is True


def test_top_sku_rows_render_to_markdown_table_with_wow():
    rows = [
        {"sku": "EE12345", "return_count": 12, "top_reason": "APPAREL_TOO_SMALL"},
        {"sku": "EE54321", "return_count": 4, "top_reason": "DID_NOT_LIKE_FABRIC"},
    ]
    previous_counts = {"EE12345": 6, "EE54321": 8}

    table = weekly.render_top_sku_table(rows, previous_counts)

    assert "| SKU | 退货数 | 上周对比 | 主要 reason |" in table
    assert "| EE12345 | 12 | 6 (↑ 100.0%) | APPAREL_TOO_SMALL |" in table
    assert "| EE54321 | 4 | 8 (↓ 50.0%) | DID_NOT_LIKE_FABRIC |" in table


def test_reason_rows_render_share_and_wow_against_previous_window():
    current = [
        {"reason": "A", "return_count": 30},
        {"reason": "B", "return_count": 10},
    ]
    previous = [
        {"reason": "A", "return_count": 20},
        {"reason": "B", "return_count": 20},
    ]

    table = weekly.render_reason_table(current, previous)

    assert "| reason | 占比 | WoW |" in table
    assert "| A | 75.0% (30) | ↑ 50.0% |" in table
    assert "| B | 25.0% (10) | ↓ 50.0% |" in table


def test_render_markdown_report_uses_inclusive_until_label():
    data = weekly.ReportData(
        shop="EP-US",
        since="2026-04-01",
        until="2026-05-01",
        compare_since="2026-03-25",
        current_summary={"return_count": 0, "sku_count": 0},
        previous_summary={"return_count": 0, "sku_count": 0},
        current_reasons=[],
        previous_reasons=[],
        top_skus=[],
        previous_sku_counts={},
        other_market_rows=[],
        rag_answer=None,
        rag_warning=None,
    )

    title, markdown = weekly.render_markdown_report(data)

    assert title == "EP-US 退货周报 2026-04-01 ~ 2026-04-30 (含)"
    assert "2026-04-01 至 2026-05-01" not in markdown


@respx.mock
def test_dingtalk_client_fetches_token_then_sends_markdown():
    token_route = respx.post(weekly.TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"accessToken": "access-token"})
    )
    send_route = respx.post(weekly.SEND_URL).mock(
        return_value=httpx.Response(200, json={"processQueryKey": "pqk"})
    )

    result = weekly.DingTalkClient("app-key", "app-secret").send_markdown(
        "cid-1",
        "Weekly",
        "## markdown",
    )

    assert result == {"processQueryKey": "pqk"}
    assert token_route.called
    assert send_route.called
    token_body = json.loads(token_route.calls[0].request.content)
    assert token_body == {"appKey": "app-key", "appSecret": "app-secret"}
    send_request = send_route.calls[0].request
    assert send_request.headers["x-acs-dingtalk-access-token"] == "access-token"
    send_body = json.loads(send_request.content)
    assert send_body["openConversationId"] == "cid-1"
    assert send_body["robotCode"] == "app-key"
    assert send_body["msgKey"] == "sampleMarkdown"
    assert json.loads(send_body["msgParam"]) == {
        "title": "Weekly",
        "text": "## markdown",
    }


def test_missing_group_lookup_logs_and_exits_1(monkeypatch, tmp_path):
    class FakeConn:
        def close(self):
            pass

    errors = []

    class FakeLogger:
        def error(self, message, *args):
            errors.append(message.format(*args))

    conversations_file = tmp_path / "dingtalk_conversations.json"
    conversations_file.write_text(json.dumps({"conversations": []}), encoding="utf-8")

    monkeypatch.setattr(weekly, "_connect", lambda: FakeConn())
    monkeypatch.setattr(weekly, "build_report_data", lambda *args, **kwargs: object())
    monkeypatch.setattr(weekly, "render_markdown_report", lambda data: ("title", "text"))
    monkeypatch.setattr(weekly, "logger", FakeLogger())

    rc = weekly.main([
        "--since",
        "2026-05-18",
        "--until",
        "2026-05-25",
        "--conversations-file",
        str(conversations_file),
    ])

    assert rc == 1
    assert any("DingTalk group lookup failed" in message for message in errors)
