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

3. Evidence bytes (ADR-072, BO-10x): after the erase step, for every erased dispute with `ERASED` evidence whose erase
   (the evidence row's `updated_at`) is within `EVIDENCE_DELETE_RETRY_DAYS`, newest first and at most `SWEEP_BATCH_SIZE`,
   it lists every version and delete marker under `evidence/{disputeId}/` and deletes them (`DeleteObjects`, ≤ 1000 per
   call). An empty prefix is a no-op, so re-runs only cost one list call per dispute. A failed delete never touches the
   committed erase; it fails the invocation and is retried by the next run while inside the window. Past the window the
   365-day lifecycle on `evidence/` (noncurrent versions after 30 days) remains the backstop. Skipped when
   `EVIDENCE_BUCKET` is unset.

Metrics (EMF, namespace `METRICS_NAMESPACE`, no dimensions): `EvidenceExpired`, `RetentionErased`,
`EvidenceVersionsDeleted`, and, only on failure, `RetentionFailed` and `EvidenceDeleteFailed` (alarm on both). Logs
carry the `disputeId` only, never an object key.

| Env | Default | |
|---|---|---|
| `DATABASE_URL` | | Local only; exactly one of this or `DATABASE_SECRET_ID` |
| `DATABASE_SECRET_ID` | | AWS: RDS-format secret (`username`, `password`, `host`, `port`, `dbname`) for `disputes_retention` |
| `DB_SSL` | `false` | Must be `true` when `DATABASE_SECRET_ID` is set (`rds.force_ssl=1`); verifies against the RDS CA |
| `SWEEP_BATCH_SIZE` | `500` | Batch cap per step |
| `DB_CONNECT_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` | `5000` / `30000` | |
| `EVIDENCE_BUCKET` | | Evidence bucket name; unset disables byte deletion |
| `EVIDENCE_DELETE_RETRY_DAYS` | `7` | How long after its erase a dispute's prefix is re-checked (1–30) |
| `AWS_ENDPOINT_URL` | | Local only (moto) |
| `METRICS_NAMESPACE` | `cd/retention-sweeper` | |
| `AWS_REGION`, `LOG_LEVEL` | `eu-north-1`, `info` | |
