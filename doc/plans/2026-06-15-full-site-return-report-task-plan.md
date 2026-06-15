# Full Site Return Report Task Plan

Date: 2026-06-15

## Goal

Add a `--full` detailed independent-site return-rate report to `services/rag/scripts/weekly_site_return_report.py` without changing default scheduled weekly behavior.

## Phases

- [complete] Read existing report script, style tag JSON, and business requirement file.
- [complete] Add pure helpers for warehouse map loading and maturity beta prediction.
- [complete] Add full-report data fetch/build/render/export path behind `--full`.
- [complete] Add required editable warehouse map JSON.
- [complete] Verify `python3 -m py_compile` and default CLI compatibility.

## Findings

- Default report path currently fetches weekly data, renders Markdown, and optionally sends DingTalk. The new behavior must branch only when `--full` is present.
- Existing style tags use `老款(未分类)` for unmatched, but the detailed business report should display unmatched as `老款`.
- Existing warehouse fetch groups raw `warehouseName`; detailed report needs explicit editable mapping and fixed display order.
- Detailed report generation is isolated under `--full`; existing weekly report build/render/send code path remains intact.
- Prediction helper falls back style -> style type -> site when mature returned quantity is below the threshold.

## Progress

- Read repository onboarding docs and the user-priority files.
- Added `site_warehouse_map.json`, full-report data builders, Markdown/XLSX exporters, and focused pure-function tests.
- `python3 -m py_compile services/rag/scripts/weekly_site_return_report.py` passed.
- `UV_CACHE_DIR=/private/tmp/uv-cache-paperclip uv run pytest tests/test_weekly_site_return_report.py` passed with 9 tests.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| `uv` could not initialize cache under `/Users/melodylu/.cache/uv` due sandbox permissions | First target pytest run | Re-ran with `UV_CACHE_DIR=/private/tmp/uv-cache-paperclip` |
