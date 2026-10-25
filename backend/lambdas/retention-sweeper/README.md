# @cd/retention-sweeper

Scheduled Lambda (EventBridge, daily) that applies the interim POPIA retention policy (docs/03 Retention, ADR-017).
It connects to Aurora as `disputes_retention` and refuses to run as any other role.

Each run, using only the injected clock (the schedule event's content is ignored):

1. `PENDING` evidence created 24 h or more ago becomes `EXPIRED` (status only).
2. Disputes terminal for one UTC calendar year or more (`resolved_at` for `RESOLVED_*`, the `WITHDRAW` history row for
   `WITHDRAWN`) are erased, each in its own transaction: description `'[erased]'`, `resolution_note` null, history
   `note`/`before`/`after` null (rows kept), evidence `ERASED` with `file_name` `'[erased]'` (the guard trigger nulls
   `s3_key` and `rejection_reason`). `dispute.updated_at` is unchanged. `SUBMITTED` and `UNDER_REVIEW` are never erased.

At most `SWEEP_BATCH_SIZE` rows per step per run; the backlog drains over later runs. A dispute that fails to erase is
rolled back whole, the rest of the batch continues, and the invocation then fails so the error alarm fires.

**It does not touch S3.** Evidence objects are removed by the 365-day lifecycle rule on the evidence bucket's
`evidence/` prefix (docs/05).

Metrics (EMF, namespace `METRICS_NAMESPACE`): `EvidenceExpired`, `RetentionErased`, and `RetentionFailed` (no dimensions, only when a dispute fails to erase; alarm on it). Logs carry the `disputeId` only.

| Env | Default | |
|---|---|---|
| `DATABASE_URL` | | Local only; exactly one of this or `DATABASE_SECRET_ID` |
| `DATABASE_SECRET_ID` | | AWS: RDS-format secret (`username`, `password`, `host`, `port`, `dbname`) for `disputes_retention` |
| `DB_SSL` | `false` | Must be `true` when `DATABASE_SECRET_ID` is set (`rds.force_ssl=1`); verifies against the RDS CA |
| `SWEEP_BATCH_SIZE` | `500` | Batch cap per step |
| `DB_CONNECT_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` | `5000` / `30000` | |
| `METRICS_NAMESPACE` | `cd/retention-sweeper` | |
| `AWS_REGION`, `LOG_LEVEL` | `eu-north-1`, `info` | |
