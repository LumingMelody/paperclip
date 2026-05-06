# Operational data retention

Two append-only logs accumulate over time. This doc summarises the current
defaults and the recommended retention strategy.

## tool_calls.jsonl (per project)

**Path**: `~/.paperclip/instances/<id>/projects/<companyId>/<projectId>/tool_calls.jsonl`

**Rotation**: built-in. When the file exceeds 10 MB (override via
`PAPERCLIP_TELEMETRY_ROTATE_BYTES`), the active log is renamed to
`tool_calls.<UTC-stamp>.jsonl` and a fresh file is started. See
`recordToolCall` / `maybeRotate` in `src/telemetry.ts`.

**Archive cleanup**: not automatic in Phase 3. Recommended ops cron:

```sh
# Keep last 90 days of telemetry archives per project
find ~/.paperclip/instances -type f -name 'tool_calls.*.jsonl' \
  -mtime +90 -delete
```

`costs.rollup` and `tool-calls search` only read the active `tool_calls.jsonl`
— archives need to be merged manually if you want historical roll-ups.

## activity_log (server DB)

**Path**: `activity_log` table (Postgres / PGlite).

**Retention**: not automatic in Phase 3. The table grows with every
mutating action across companies. For a self-hosted single-instance
deployment with one Ever-Pretty company this is fine for months. At
scale, consider:

- `DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL '180 days'`
  on a monthly cron — coarse, drops old audit
- Partition by month and detach/archive old partitions — proper but
  invasive (schema change)
- Stream to an external append-only store (S3, BigQuery) and rotate the
  warm DB to the last 30 days — best for compliance use cases

These are deferred to Phase 5+ once a real growth signal appears.

## decisions.log (repo)

**Path**: `decisions.log` (repo root).

**Retention**: never. This is a permanent architecture record — same
half-life as ADRs. Don't truncate.
