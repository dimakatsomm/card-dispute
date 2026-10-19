# 03 — Data Model

Aurora PostgreSQL, one cluster, one schema per service. Each service connects as its own role
with privileges on its own schema only.

## Conventions
- `id bigint generated always as identity primary key` — internal only, never in an API.
- `<entity>_id uuid not null unique` — public id. UUIDv7 via native `uuidv7()` (Aurora PostgreSQL 18, verified 2026-10-09).
  Column default `uuidv7()`.
- Cross-service references are `uuid` columns with **no FK** (other schema). Integrity is
  checked through the owning service's API at write time.
- Money: `numeric(12,2)` + `currency char(3)`. Never float.
- Every table: `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`;
  `updated_at` maintained by a shared trigger function `set_updated_at()` (created per schema).
- Enums as `text` + `CHECK` constraint (easier to migrate than PG enum types).
- Financial and audit rows are never deleted; service roles have no DELETE on them.
- Every in-schema FK is `ON DELETE RESTRICT` (PR-DB-10).
- Exception to the audit-field rule: insert-only tables (`dispute_status_history`) have `created_at` only.

## auth
### auth_identity
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| auth_id | uuid UQ | |
| cognito_sub | text UQ not null | Cognito `sub` |
| username | text UQ not null | Cognito username (lower-cased) |
| user_id | uuid UQ not null | logical ref → users.app_user.user_id; lets `/validate` return userId without calling users (ADR-007). Written once at provisioning. |
| status | text | `ACTIVE | DISABLED` |
| created_at, updated_at | timestamptz | |

No password column: Cognito owns credentials (ADR-004).

## users
### app_user
(`user` is a reserved word in PostgreSQL — renamed, PR-01 F6)
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| user_id | uuid UQ | |
| auth_id | uuid UQ not null | logical ref → auth.auth_identity.auth_id |
| name, surname | text not null | |
| cellphone_number | text | E.164, CHECK `^\+[1-9][0-9]{7,14}$` |
| email | citext UQ not null | |
| status | text | `ACTIVE | SUSPENDED | CLOSED` — profile lifecycle only; access is governed by `auth.auth_identity.status` (PR-01 F7) |

### account
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| account_id | uuid UQ | |
| user_id | bigint FK → app_user.id | |
| account_number_masked | text | e.g. `****4821` — full number never stored |
| account_type | text | `CHEQUE | SAVINGS | CREDIT` |
| currency | char(3) | |
| status | text | `ACTIVE | FROZEN | CLOSED` |

### card
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| card_id | uuid UQ | |
| account_id | bigint FK → account.id | |
| token | text UQ not null | vault/processor token, never returned to users |
| last4 | char(4) not null | CHECK `^[0-9]{4}$` |
| expiry_month | smallint not null | CHECK 1–12 |
| expiry_year | smallint not null | CHECK 2000–2100 |
| brand | text | `VISA | MASTERCARD | AMEX` |
| card_type | text | `DEBIT | CREDIT` |
| status | text | `ACTIVE | BLOCKED | CANCELLED` — **no EXPIRED**: expiry is derived from month/year by `isCardExpired()` only (PR-DB-4, single source of truth) |

Indexes: `account(user_id)`, `card(account_id)`.

## transactions
### transaction
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| transaction_id | uuid UQ | |
| user_id | uuid not null | logical; ownership scoping (denormalised from users) |
| account_id | uuid not null | logical |
| card_id | uuid not null | logical |
| amount | numeric(12,2) | > 0; direction given by `type` |
| currency | char(3) | |
| merchant_name | text | |
| mcc | char(4) | merchant category code |
| type | text | `PURCHASE | REFUND | ATM_WITHDRAWAL | FEE` |
| status | text | `PENDING | POSTED | DECLINED | REVERSED` |
| transaction_at | timestamptz not null | when it happened |
| posted_at | timestamptz null | when it settled; dispute window counts from here. CHECK `status <> 'POSTED' OR posted_at IS NOT NULL` |

Indexes: `(user_id, transaction_at desc, transaction_id desc)` (default list + cursor),
`(user_id, card_id, transaction_at desc)`, `(user_id, account_id, transaction_at desc)`.

Mock data: seed generator produces 3 users × 1–2 accounts × 1–2 cards × ~200 transactions across
the last 180 days, with a mix of statuses so the 120-day window and POSTED-only rules are exercised.
Cognito users for the seed are created by a script (dev) or the mock issuer (local).

## disputes
Disputes stores only what it owns. Transaction details (amount, merchant, card, account, dates) are
read live from transactions by `transaction_id`, never copied (ADR-024). A dispute always covers the
full transaction amount, so there is no amount column.

### dispute
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| dispute_id | uuid UQ | default `uuidv7()` |
| transaction_id | uuid not null **UQ** | logical ref → transactions; one dispute per transaction, ever (ADR-020). The UQ is also the retry/idempotency guard (ADR-023) |
| user_id | uuid not null | owner; every query is scoped by it |
| reason_code | text not null | CHECK in the 7 reason codes |
| description | text not null | CHECK length 10–2000 |
| status | text not null | CHECK `SUBMITTED | UNDER_REVIEW | RESOLVED_ACCEPTED | RESOLVED_REJECTED | WITHDRAWN` |
| version | int not null default 1 | optimistic concurrency / ETag |
| resolved_at | timestamptz null | CHECK set exactly when status is `RESOLVED_*` |
| resolution_note | text null | |
| created_by, updated_by | text not null | `USER:<uuid>` / `SYSTEM_RULE:<rule>` / `AGENT:<id>` |
| created_at, updated_at | timestamptz | |

Indexes: `(user_id, updated_at desc, dispute_id desc)` for `GET /disputes` paging; `(status, created_at)` for the back-office queue.
`disputes_app` has no DELETE.

### dispute_status_history (insert-only)
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| dispute_id | bigint FK → dispute.id ON DELETE RESTRICT | indexed |
| action | text not null | CHECK `CREATE | EDIT | EVIDENCE_ADDED | EVIDENCE_REJECTED | REVIEW | RESOLVE | WITHDRAW` |
| from_status | text null | null on CREATE |
| to_status | text not null | |
| actor_type | text not null | CHECK `USER | SYSTEM_RULE | AGENT` |
| actor_id | text not null | never exposed to the customer |
| note | text null | |
| before, after | jsonb null | changed fields on EDIT |
| created_at | timestamptz | no `updated_at` (insert-only) |

`disputes_app`: INSERT, SELECT only. `disputes_retention`: `UPDATE (note, before, after)` only.

### dispute_evidence
| column | type | notes |
|---|---|---|
| id | bigint PK | |
| evidence_id | uuid UQ | also the object name in both buckets |
| dispute_id | bigint FK → dispute.id ON DELETE RESTRICT | indexed |
| file_name | text not null | client-declared, display only (sanitised, ≤ 255); never used in an S3 key |
| declared_content_type | text not null | CHECK `application/pdf | image/jpeg | image/png` |
| declared_size_bytes | int not null | CHECK 1–10 485 760 |
| declared_sha256 | char(64) not null | signed into the upload URL; S3 verifies it |
| s3_key | text null | `evidence/{disputeId}/{evidenceId}` in the evidence bucket; set only when STORED |
| status | text not null | CHECK `PENDING | STORED | REJECTED | EXPIRED | ERASED` |
| rejection_reason | text null | CHECK `MALWARE | TYPE_MISMATCH | CHECKSUM | SIZE`; set only when REJECTED |
| stored_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

- `PENDING` → `STORED` | `REJECTED` (by evidence-intake via the service port), or → `EXPIRED` (retention sweeper: PENDING older than 1 day).
- Cap: ≤ 5 rows per dispute with status `PENDING` or `STORED` (app-enforced inside the insert transaction, with the dispute row locked).
- No file bytes or object metadata from the client are trusted until evidence-intake has checked them.

### Removed (owner, 2026-10-10 — ADR-023)
`idempotency_key`, `outbox`, `processed_event`, `notification_cursor` are not built.
- Idempotency → `unique (transaction_id)`.
- Event delivery → publish after commit, best-effort; the DB is the source of truth.
- Consumer dedupe/order → consumers are idempotent by design (internal endpoints + `expectedVersion`); a rare duplicate email is accepted.

## Event payloads (SQS)
```json
{ "eventId": "uuid", "eventType": "DisputeCreated|DisputeEdited|DisputeStatusChanged|EvidenceUploaded",
  "occurredAt": "…", "disputeId": "uuid", "transactionId": "uuid", "userId": "uuid", "version": 3,
  "data": { "fromStatus": "…", "toStatus": "…", "reasonCode": "…" } }
```
No PII (no name, email, phone, PAN) in any event.

## Customer provisioning (PR-01 F7)
`auth_identity.user_id` and `app_user.auth_id` reference each other logically. No FK spans the
schemas, so there is no insert-order deadlock. A single **provisioning job** (`local/seed` in M1,
`tools/provision-customer` in M3) does the following in order:
1. Create the Cognito user.
2. Generate `user_id` and `auth_id` (`uuidv7`).
3. Insert `users.app_user`.
4. Insert `auth.auth_identity` with `status = ACTIVE`.

Steps 3–4 retry until both rows exist. Offboarding sets `auth_identity.status = DISABLED`, disables the Cognito user, and sets `app_user.status = CLOSED`.

## Retention (POPIA — interim policy, owner decision 2026-10-09, ADR-017)
1 year after a dispute reaches a terminal state:
- `dispute.description`, `resolution_note` and history `note`/`before`/`after` → replaced with `'[erased]'` / `null` (the row stays — financial record).
- `dispute_evidence` S3 objects deleted (S3 lifecycle 365 days on `evidence/`), rows marked `ERASED`.
Run by a scheduled `retention-sweeper` job (M2), connecting as `disputes_retention` (column-scoped UPDATE on dispute text fields, history `note/before/after`, evidence `status`). This is an interim policy; revisit with compliance before production.
