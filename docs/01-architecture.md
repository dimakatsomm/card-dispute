# 01 — Architecture

## Topology

```
Client ─► CloudFront https://<id>.cloudfront.net (WAF) ─► ALB (VPC origin preferred, V-06) ─► ECS Fargate (private subnets)   (ADR-046, no custom domain)
                         /api/me            → users:8080        (CloudFront Function strips /api)
                         /api/transactions  → transactions:8080
                         /api/dispute*      → disputes:8080
                         /*                 → web (nginx SPA)

ECS services: auth | users | transactions | disputes — each listens on 8080 (public) and 8081 (service)
  service-to-service calls over ECS Service Connect to port 8081 (cloud map namespace "cd.internal")

Aurora PostgreSQL Serverless v2 — one cluster; schemas auth, users, transactions, disputes;
  one DB role per service with grants on its own schema only

disputes ─(after commit, best-effort)─► SQS dispute-notifications (+DLQ) ─► dispute-notifier Lambda
                                              ─► users GET /users/{userId}/contact (service token) ─► SES

Evidence (ADR-028, presigned — disputes never touches file bytes):
  client ─PUT (presigned, signed type/length/sha256)─► S3 quarantine bucket (private, SSE-KMS, 1-day lifecycle)
     ─► malware scan (GuardDuty Malware Protection for S3 — ⚠ af-south-1 availability unverified)
     ─► EventBridge scan-result event ─► evidence-intake Lambda
           checks magic bytes (ranged GET), size, checksum, scan verdict
           clean  → copy to S3 evidence bucket (private, SSE-KMS, versioned) + delete from quarantine
           bad    → delete from quarantine
         ─► disputes PUT /dispute/{transactionId}/evidence/{evidenceId} (service port, via internal ALB)

Supporting: Cognito, Secrets Manager (DB creds), KMS (data + S3 keys), ECR, CloudWatch Logs/Alarms, X-Ray
```
Lambdas: evidence-intake, dispute-notifier, retention-sweeper. No auto-review (owner, Q-14 → ADR-033): new disputes wait in SUBMITTED until an agent picks them up from the review queue.

## Source of truth (ADR-023)
- **The database is the source of truth.** A dispute's state and timeline are whatever is in
  `dispute` and `dispute_status_history`. `GET /dispute/{transactionId}` always shows reality.
- **Events are best-effort side effects**: emails, queueing for review. They are published to SQS after the
  DB commit, with no outbox. If the process dies between commit and publish (rare), the event is lost:
  - a missing email → the customer still sees the change in the app timeline;
  - a missing `DisputeCreated` → the dispute stays SUBMITTED, and the back-office queue query lists
    SUBMITTED disputes anyway (agents can pick it up directly).
  This trade was made deliberately for simplicity (owner, 2026-10-10). Reinstate an outbox if emails
  become legally required notices.
- **Consumers tolerate duplicates and reordering** instead of tracking them. SQS is at-least-once,
  so a duplicate email is possible and accepted. Each email states the status at the time and the
  date. State-changing consumers (evidence-intake) call idempotent service-port endpoints,
  so a duplicate is a no-op.

## Request flows

### User request (e.g. `GET /transactions?cardId=…`)
1. ALB → transactions task. `@cd/auth-client` reads `Authorization: Bearer`.
2. auth-client → auth `POST /validate` over Service Connect (cached until `min(exp, 60s)`).
3. auth verifies Cognito JWT (JWKS, issuer, `token_use=access`, `client_id` allow-list, `exp`),
   maps `sub` → `auth_id` → returns `{ valid, principalType: "user", authId, userId, scopes, exp }`.
4. Handler queries `transactions` scoped by `user_id = principal.userId`. A `cardId` that is not
   the caller's yields an empty page (never another user's data).

### Service request (e.g. back-office → users `GET /cards`)
1. The caller obtains a Cognito client_credentials token (cached until near expiry) for its own app client.
2. Calls users `GET /cards?userId=…&cardId=…` with that token.
3. users' auth-client validates → `principalType: "service"`; route guard `requireService("users/cards.read")`.
   A user token → 403.

### Transaction list with `disputable` flag (ADR-021)
1. transactions validates the user token and runs its page query (scoped by userId).
2. In parallel, with a 2 s timeout each:
   - users `GET /cards?userId=` (cached 60 s per user) → card expiry
   - disputes `GET :8081/disputes?userId=&transactionIds=<page ids>` → existing disputes
3. For each row: `evaluateTransactionEligibility(txn, card, dispute, dbNow)` → `disputable`.
4. If either call fails or times out, every row gets `disputable: { allowed: false, reason: "UNAVAILABLE" }`.
   The list still returns.

### Create dispute
1. disputes validates the user token.
2. Calls transactions `GET :8081/transactions?userId=<principal.userId>&transactionIds=<id>` (service
   token, scope `transactions/read`) → raw txn, no enrichment, or not found. `userId` comes only from the validated principal.
3. Calls users `GET /cards?userId=&cardId=<txn.cardId>` (service token) → card expiry.
4. `evaluateTransactionEligibility(txn, card, existingDispute, dbNow)` + `validateDisputeInput(input)`.
5. One DB transaction: insert `dispute` + one `dispute_evidence` row per declared file (`PENDING`) + history (CREATE).
6. Generate presigned PUT URLs for the quarantine bucket (10 min; signed Content-Type, Content-Length,
   x-amz-checksum-sha256). No network call; signing is local.
   `unique (transaction_id)` makes a duplicate or retried POST fail with 409 `ALREADY_DISPUTED`.
   This is the idempotency mechanism (ADR-023).
7. Commit → 201 (dispute + upload URLs) → publish `DisputeCreated` (best-effort; failures logged + metric).
8. The client uploads directly to S3. The evidence path then runs asynchronously (topology above).

### Read disputes (list / detail)
- disputes reads its own rows, then calls transactions `GET :8081/transactions?userId=&transactionIds=`
  once per page to attach amount, merchant and date. Transaction data is **not** copied into disputes.
- Account/card filter (ADR-025): disputes first gets the caller's disputed transaction ids, asks transactions
  which of those belong to the account/card (same internal endpoint + `accountId`/`cardId`), then pages its
  own rows in that set. Cost: per-customer dispute count is small; ids are sent in chunks of 100. Revisit
  (store `card_id` on dispute) only if a customer can accumulate thousands of disputes.
- If transactions is down → dispute data is returned with `transaction: null` (degrades, never fails).

### Resolution
- Back-office agents list the queue with `GET :8081/review-queue` (SUBMITTED / UNDER_REVIEW, oldest first), pick one
  with `PUT /dispute/{transactionId}/review` (SUBMITTED → UNDER_REVIEW) and close it with `/resolution`.
  **No automation changes dispute status** (ADR-016, ADR-033). Only a human AGENT reviews or resolves.
- Back-office uses the internal endpoints with scope `disputes/resolve`.
- Every transition → after commit → `DisputeStatusChanged` → notifier emails the owner.

## Why these choices
| Choice | Reason | Alternative rejected |
|---|---|---|
| Auth as validation service (not just JWKS per service) | Owner asked for `POST /validate`; centralises issuer/client allow-list, sub→user mapping and the disable switch | Each service verifies JWKS locally — faster, but duplicates mapping logic. auth-client caches to keep latency low. |
| One Aurora cluster, schema per service | Cost at dev scale; isolation enforced by DB roles | Cluster per service — 4x cost, no benefit at dev scale |
| Publish after commit, no outbox | Owner: outbox/dedupe tables are overkill. DB is the truth; events only drive emails/queueing | Transactional outbox + relay — guaranteed delivery, 2 extra tables + a Lambda |
| `unique (transaction_id)` as idempotency | One dispute per txn already; a retry is just a duplicate | Idempotency-key table — extra table for a guarantee the constraint already gives |
| Transaction data read live from transactions | No copied data to drift; disputes stores only what it owns | Snapshot columns on dispute |
| Service Connect | Native discovery, no internal ALB for task-to-task | Internal ALB everywhere |
| Presigned uploads to a quarantine bucket (ADR-028) | Card dispute evidence often shows full PANs. Keeping the bytes out of the disputes service keeps it out of the PCI DSS data path, keeps untrusted files away from the process holding DB creds, and lets mobile uploads go straight to S3 | Multipart through disputes (ADR-027) — one call and atomic, but the service handles cardholder data and untrusted bytes |
| Notifier fetches contact by userId | No email address in queue messages | Embed email in events (rejected — PII in queues) |

## Failure handling
- Inter-service HTTP: 2 s timeout, 1 retry on GETs only, circuit opens after 5 consecutive failures (30 s).
- SQS publish after commit: 3 in-process retries with backoff. On final failure: error log +
  `EventPublishFailed` metric + alarm. The dispute itself is already committed.
- SQS: visibility timeout 6× Lambda timeout, `maxReceiveCount` 5 → DLQ. CloudWatch alarm on DLQ depth > 0.
- Lambdas use partial batch responses (`ReportBatchItemFailures`).

## Changes after peer review 01
- **Lambdas cannot use ECS Service Connect** (it is a per-task Envoy proxy). Lambda → service calls go
  through an **internal ALB** targeting the service port 8081 (private, SG allows the Lambda SG only).
- **Ordering:** no consumer relies on queue order. Emails state their
  own status and date, so a late email is self-explanatory (no cursor table, ADR-023).
- **Single-AZ honesty:** one NAT in one AZ means an AZ outage cuts egress (Cognito token/JWKS) for
  the whole dev environment. Accepted for dev.
