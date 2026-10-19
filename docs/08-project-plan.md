# 08 — Project Plan: Card Dispute Platform

**Status:** 2026-10-11. Planning (M0) is complete, including a lint-clean OpenAPI contract. No application code yet.
**Owner:** dimakatsomm@icloud.com · **Region:** AWS af-south-1 · **Environment:** single `dev`.
This document is the complete plan. The detailed contracts it summarises live in docs 00–07 and 09,
`docs/openapi/` and `orchestration/backlog.md`. If this summary and a detailed contract disagree, the detailed contract wins.

---

## 1. Purpose

Cardholders can dispute a card transaction themselves. They:
- browse their accounts, cards and transactions
- dispute a transaction, optionally with PDF/image evidence
- follow the dispute on a timeline, and are emailed at every step

Back-office agents work the disputes to a decision (**deferred** — owner 2026-10-19: client-facing first).

**Must get right:**
- A customer can only ever see or dispute their own data.
- Every dispute change is valid, versioned and auditable.

Built to **production patterns**:
- microservices on ECS
- everything containerised
- per-service pipelines with approval

---

## 2. Actors

| Actor | How they interact |
|---|---|
| **Customer** | React web app at `https://<app-domain>` → API at the same origin under `/api`, Cognito login |
| **Back-office agent** | ⏸ Deferred (owner: client-facing first). Contract kept in `docs/openapi`; not built in M1–M4 |
| **Services** | auth, users, transactions, disputes, calling each other on the service port with Cognito service tokens |
| **System jobs** | evidence-intake, dispute-notifier and retention-sweeper Lambdas (housekeeping only; never change dispute status) |

---

## 3. Scope

**In**
- Everything in §4.
- Mock customers, accounts, cards and transactions (ZAR).
- Local stack in containers.
- Terraform-built dev in af-south-1.
- Per-deployable CI/CD.

**Out (deferred, with reason)**
- **Back-office (review queue, review, resolution, agent access) — deferred** (owner 2026-10-19: client-facing first). The contract stays in `docs/openapi`; nothing is built in M1–M4.
- Real card-processor/scheme chargebacks: mock data is used.
- Customer self-sign-up: customers are provisioned.
- Multiple environments, DR, production-scale load testing: out of scope for the first release.
- Partial disputes: the owner ruled them out.

---

## 4. Functional specification

### 4.1 Authentication & access (F-AUTH)
| # | Requirement |
|---|---|
| F-AUTH-1 | Customers sign in with Cognito hosted login (authorization code + PKCE). No passwords are stored by us. |
| F-AUTH-2 | Every API call carries a Cognito **access** token. ID tokens, expired tokens, wrong issuer and unknown clients are rejected → 401. |
| F-AUTH-3 | The auth service's `POST /validate` (service port) validates tokens centrally and maps Cognito `sub` → `authId` → `userId`. Results are cached ≤ 60 s by callers. |
| F-AUTH-4 | One switch disables access: `auth_identity.status = DISABLED` → `valid:false, disabled`. Effective within 60 s. |
| F-AUTH-5 | Customer routes exist only on port 8080 (user token required). Service routes exist only on port 8081 (service token + scope required). No path prefix, no trusted header. |
| F-AUTH-6 | Every query is scoped to the caller. Another customer's resource → **404**, never 403. |

### 4.2 Profile, accounts & cards (F-ACC)
| # | Requirement |
|---|---|
| F-ACC-1 | `GET /me` returns the profile plus accounts, each with its masked cards (brand, type, last4, expiry, `expired`, status). |
| F-ACC-2 | `expired` is computed by the server (valid through the last day of the expiry month, UTC). The UI never does date maths. |
| F-ACC-3 | The card token, PAN and CVV are never returned. Only `last4` is stored. |
| F-ACC-4 | Selecting an account in the UI shows its cards with no extra API call. |

### 4.3 Transactions (F-TXN)
| # | Requirement |
|---|---|
| F-TXN-1 | `GET /transactions` lists the caller's transactions across all accounts by default. |
| F-TXN-2 | Filters: `accountId`, `cardId`, `transactionId`, date range, status (multi), amount range. Paged by cursor (25 per page by default, max 100), newest first. |
| F-TXN-3 | Every row carries `dispute` (id + status, or null) and `disputable {allowed, reason}`, computed by the **same** rule function the create-dispute endpoint uses. |
| F-TXN-4 | If users or disputes don't answer within 2 s, the list still returns. Every row then shows `disputable: {allowed:false, reason:UNAVAILABLE}` (fails closed). |
| F-TXN-5 | An unowned account or card filter → empty page. |

### 4.4 Disputes — customer (F-DSP)
| # | Requirement |
|---|---|
| F-DSP-1 | **Eligibility.** The first failing rule wins:<br>1. never disputed before, incl. withdrawn → `ALREADY_DISPUTED`<br>2. card not expired → `CARD_EXPIRED`<br>3. transaction POSTED → `TXN_NOT_POSTED`<br>4. not a refund → `TXN_TYPE_NOT_DISPUTABLE`<br>5. ≤ **120 days** since posting → `OUTSIDE_WINDOW` |
| F-DSP-2 | **Reason codes:** FRAUD, NOT_RECEIVED, DUPLICATE, INCORRECT_AMOUNT, CANCELLED_SUBSCRIPTION, DEFECTIVE_GOODS, OTHER. Description 10–2000 chars. |
| F-DSP-3 | **Full amount only.** There is no amount field anywhere. |
| F-DSP-4 | `POST /dispute/{transactionId}` (JSON) creates the dispute in `SUBMITTED`, with optional declarations for 0–5 evidence files. A retry or double-submit → 409 `ALREADY_DISPUTED` (the unique constraint is the idempotency guard). |
| F-DSP-5 | `GET /dispute/{transactionId}` returns the dispute, its evidence and an ascending **timeline**: SUBMITTED, EDITED, EVIDENCE_ADDED, EVIDENCE_REJECTED, UNDER_REVIEW, RESOLVED_ACCEPTED/REJECTED, WITHDRAWN. Each event is attributed to `CUSTOMER` or `BANK`; agent identities are never shown. |
| F-DSP-6 | `GET /disputes` lists the caller's disputes. Filters: status, `accountId`, `cardId` (resolved through transactions). Paged, newest update first. Each item shows its last event. |
| F-DSP-7 | `PUT /dispute/{transactionId}` **edits** the reason/description while SUBMITTED, or **withdraws** while SUBMITTED/UNDER_REVIEW. Withdrawal is **final**; the UI warns. Requires `If-Match` → 412 if stale, 428 if missing. |
| F-DSP-8 | Transaction details (amount, merchant, card, account, dates) are read live from transactions, never copied. If transactions is down: list/detail show `transaction: null`; a filtered list → 503. |

### 4.5 Evidence (F-EVD)
| # | Requirement |
|---|---|
| F-EVD-1 | Files are declared with name, type (PDF/JPEG/PNG), size (≤ 10 MB) and SHA-256. Max **5** PENDING/STORED per dispute. |
| F-EVD-2 | The API returns one **presigned PUT** URL per file (10 min). Content-Type, Content-Length and the SHA-256 checksum are signed in, so S3 rejects anything else. **File bytes never pass through our services** (PCI scope, untrusted-file isolation). |
| F-EVD-3 | Files land in a **quarantine bucket**. A malware scan runs (GuardDuty Malware Protection for S3 — availability V-03). Then **evidence-intake** checks the magic bytes, size and checksum. |
| F-EVD-4 | Clean files are copied to the evidence bucket → `STORED`, timeline `EVIDENCE_ADDED`. Bad files are deleted → `REJECTED` with a reason (MALWARE / TYPE_MISMATCH / CHECKSUM / SIZE), timeline `EVIDENCE_REJECTED`. |
| F-EVD-5 | `POST /dispute/{transactionId}/evidence` declares more files later (SUBMITTED/UNDER_REVIEW only). |
| F-EVD-6 | Unused upload slots → `EXPIRED` after 1 day and stop counting toward the cap. |

### 4.6 Back-office review (F-BO) — ⏸ deferred, contract only
> Not built in M1–M4. Disputes stay SUBMITTED unless withdrawn. Seed data includes UNDER_REVIEW and
> RESOLVED disputes so the customer timeline and resolution note can be tested.
| # | Requirement |
|---|---|
| F-BO-1 | `GET /review-queue` (service port, scope `disputes/review`) lists SUBMITTED / UNDER_REVIEW disputes across customers, oldest first. |
| F-BO-2 | An agent picks a dispute: `PUT /dispute/{transactionId}/review` → UNDER_REVIEW (from then on the customer can no longer edit). |
| F-BO-3 | An agent resolves it: `PUT /dispute/{transactionId}/resolution` → RESOLVED_ACCEPTED / RESOLVED_REJECTED with a customer-visible note. |
| F-BO-4 | **Only human agents** (actor type AGENT, Cognito `agents` group) review or resolve. **No automation changes dispute status.** |
| F-BO-5 | Writes carry `expectedVersion`. Concurrent customer withdraw vs agent action: the first commit wins, the other gets 412/409. |
| F-BO-6 | Agent access path (Q-17): decided when back-office is scheduled. |

### 4.7 Notifications (F-NTF)
| # | Requirement |
|---|---|
| F-NTF-1 | Every status change (created, under review, resolved, withdrawn) emails the customer via SES. |
| F-NTF-2 | Disputes publishes events **after commit, best-effort** to SQS. The DB/timeline is the source of truth. A publish failure → `EventPublishFailed` alarm. |
| F-NTF-3 | The notifier fetches the email by `userId` from users (events carry no PII). A rare duplicate email is accepted; each email states its status and date. |
| F-NTF-4 | Sender `noreply@<app-domain>` (SES domain identity with DKIM, SPF, DMARC); Reply-To `dimakatsomm@icloud.com`. SES sandbox for dev → verified recipients only. |

### 4.8 Data retention (F-RET)
| # | Requirement |
|---|---|
| F-RET-1 | 1 year after a dispute closes: description, notes and edit history are erased, evidence objects are deleted (status `ERASED`), and the rows are kept (financial record). |
| F-RET-2 | Run daily by **retention-sweeper**, using a role that can update only those columns. |

### 4.9 Web app (F-WEB)
| Screen | Behaviour |
|---|---|
| Login | Cognito hosted login (mock issuer locally). Tokens are kept in memory only. |
| Home | Profile, accounts with masked cards (expired marked), recent transactions |
| Account | Its cards + transactions filtered by account |
| Card | Transactions filtered by card. Infinite scroll. |
| Transaction row | Dispute status chip if disputed. **Dispute** button only when `disputable.allowed`; otherwise a human-readable reason. |
| Dispute form | Reason, description, 0–5 files. SHA-256 in the browser, then direct upload to S3 with progress and retry. 409 → open the existing dispute. |
| Disputes | List with status/account/card filters |
| Dispute detail | Timeline, evidence statuses, add evidence, edit (SUBMITTED), withdraw (with a "final" warning) |

### 4.10 Non-functional requirements
| Area | Target |
|---|---|
| Security | OWASP ASVS L2 intent; threat model in docs/05; security review on every 🔒 task |
| Privacy | No PAN/CVV; PII redacted in logs; events id-only; POPIA retention (F-RET) |
| Latency (dev) | p95 < 500 ms for list endpoints at dev load; 2 s timeout on every service call |
| Availability (dev) | Single NAT/AZ egress accepted; ECS circuit-breaker rollback on deploy |
| Auditability | Insert-only status history; actor recorded for every change |
| Observability | JSON logs with correlation id across HTTP and SQS; X-Ray traces; alarms (§7.5) |
| Accessibility | WCAG 2.1 AA for the web app |

---

## 5. Architecture

```
Browser ─► CloudFront https://<app-domain> (WAF) ─┬─ /*     ─HTTPS─► ALB ─► web (nginx SPA)          ECS, ARM64
                                         └─ /api/* ─HTTPS─► ALB ─► :8080 users | transactions | disputes
          (CloudFront Function strips /api; ALB accepts CloudFront only)
Services ⇄ :8081 via ECS Service Connect (service token + scope)
Lambdas ─► internal ALB ─► :8081
Aurora PostgreSQL 18 Serverless v2 — schemas auth | users | transactions | disputes (no cross-schema access)

disputes ─(after commit)─► SQS dispute-notifications (+DLQ) ─► dispute-notifier ─► users :8081 contact ─► SES
client ─presigned PUT─► S3 quarantine ─► GuardDuty scan ─► EventBridge ─► evidence-intake
                                                  ├ clean → S3 evidence bucket → disputes :8081 (STORED)
                                                  └ bad   → delete            → disputes :8081 (REJECTED)
EventBridge (daily) ─► retention-sweeper
Supporting: Route 53 sub-zone <app-domain>, ACM, Cognito, Secrets Manager, KMS, ECR, CloudWatch, X-Ray.
```

Principles:
0. **Functional architecture, no classes** (docs/10): pure core → `(deps) => (input) => Result` use-cases → factory-function adapters → thin routes; one composition root per deployable.
1. Two ports per service; the token decides.
2. Database = source of truth; events are side effects.
3. No service reads another's schema or imports another's folder.
4. Service-port lookup endpoints make no further calls (no loops).
5. One shared pure rule engine (`@cd/dispute-domain`).
6. Everything is a container.

---

## 6. API contract

The machine-readable contract is **`docs/openapi/`**: OpenAPI 3.1, one file per service per port, `redocly lint` clean.
The frontend client is generated from it, and `contract.yml` blocks breaking changes.

| Service | Method & path | Port | Caller / scope | Purpose |
|---|---|---|---|---|
| auth | `POST /validate` | 8081 | services · `auth/validate` | Validate a token |
| users | `GET /me` | 8080 | customer | Profile, accounts, cards |
| users | `GET /cards` | 8081 | services · `users/cards.read` | Card expiry lookup |
| users | `GET /users/{userId}/contact` | 8081 | notifier · `users/contact.read` | Email for notifications |
| transactions | `GET /transactions` | 8080 | customer | List + `dispute` + `disputable` |
| transactions | `GET /transactions` | 8081 | disputes · `transactions/read` | Raw batch lookup by ids (+ account/card filter) |
| disputes | `GET /disputes` | 8080 | customer | My disputes |
| disputes | `POST /dispute/{transactionId}` | 8080 | customer | Create + upload URLs |
| disputes | `GET /dispute/{transactionId}` | 8080 | customer | Detail + timeline |
| disputes | `PUT /dispute/{transactionId}` | 8080 | customer | Edit / withdraw |
| disputes | `POST /dispute/{transactionId}/evidence` | 8080 | customer | More upload URLs |
| disputes | `GET /disputes` | 8081 | transactions · `disputes/read` | Batch dispute state |
| disputes | `GET /review-queue` | 8081 | back-office · `disputes/review` | Agent queue |
| disputes | `PUT /dispute/{transactionId}/review` | 8081 | back-office · `disputes/review` | Pick up |
| disputes | `PUT /dispute/{transactionId}/resolution` | 8081 | back-office · `disputes/resolve` | Resolve |
| disputes | `PUT /dispute/{transactionId}/evidence/{evidenceId}` | 8081 | evidence-intake · `disputes/evidence.write` | Scan result |
| all | `GET /health`, `GET /ready` | both | — | Probes |

Conventions:
- JSON, camelCase, UUIDs, money as decimal strings + ISO currency.
- RFC 9457 errors with a stable `code`.
- `x-correlation-id` on every response.
- `ETag`/`If-Match` on disputes.

---

## 7. Technical design

### 7.1 Data model (8 tables)
| Schema.table | Key columns |
|---|---|
| auth.auth_identity | auth_id, cognito_sub (UQ), username, user_id, status ACTIVE/DISABLED |
| users.app_user | user_id, auth_id, name, surname, email (UQ), cellphone (E.164), status |
| users.account | account_id, user_id FK, account_number_masked, type, currency, status |
| users.card | card_id, account_id FK, token (UQ, hidden), last4, expiry_month/year, brand, type, status ACTIVE/BLOCKED/CANCELLED |
| transactions.transaction | transaction_id, user_id, account_id, card_id, amount numeric(12,2), currency, merchant, mcc, type, status, transaction_at, posted_at |
| disputes.dispute | dispute_id, transaction_id (**UQ — one ever**), user_id, reason_code, description, status, version, resolved_at, resolution_note, created_by/updated_by |
| disputes.dispute_status_history | insert-only: action, from/to status, actor type/id, note, before/after, created_at |
| disputes.dispute_evidence | evidence_id, declared type/size/sha256, s3_key, status PENDING/STORED/REJECTED/EXPIRED/ERASED, rejection_reason |

Conventions:
- Internal bigint PKs; public `uuidv7()` ids.
- `created_at`/`updated_at` (trigger).
- Text + CHECK enums.
- `ON DELETE RESTRICT`.
- No DELETE grants on financial or audit rows.
- Per-service migrator/app roles + `disputes_retention`.

Not built on purpose: idempotency/outbox/dedupe tables.

### 7.2 Dispute state machine
```
SUBMITTED ──REVIEW (agent)──► UNDER_REVIEW ──RESOLVE (agent)──► RESOLVED_ACCEPTED | RESOLVED_REJECTED
    │  └─EDIT (customer)                          │
    └──WITHDRAW (customer)──► WITHDRAWN ◄──WITHDRAW (customer)
SUBMITTED ──RESOLVE (agent)──► RESOLVED_*   (allowed; agent may skip review)
```
Terminal states reject everything (`INVALID_TRANSITION`). A row lock + version guard every change. The DB clock is the only clock.

### 7.3 Security controls
- **Identity:** Cognito user pool. One confidential client per caller: svc-transactions, svc-disputes, svc-notifier, svc-evidence-intake, svc-backoffice.
- **Network:**
  - CloudFront → ALB → 8080 only; 8081 only from service SGs and the Lambda SG (via the ALB's 8081 listener).
  - Aurora private with TLS forced.
  - One NAT.
- **Data:**
  - KMS keys `cd-data`, `cd-evidence`.
  - Quarantine bucket: CORS PUT from the app origin only, 1-day lifecycle.
  - Evidence bucket: versioned, 365-day lifecycle.
- **IAM:**
  - Least privilege, no `*`.
  - The disputes task can only *sign* quarantine PUTs.
  - Only evidence-intake reads quarantine.
- **Edge:** CloudFront HTTPS on `<app-domain>` (ACM), HTTPS to the ALB origin; WAF on CloudFront with managed rules + rate limiting (M4: per-user caps on dispute create/evidence).

### 7.4 Repository & containers (docs/09)
```
backend/{auth,users,transactions,disputes}/   src · migrations · test · Dockerfile
backend/lambdas/{evidence-intake,dispute-notifier,retention-sweeper}/   container-image Lambdas
backend/packages/{shared,auth-client,dispute-domain,db}/
frontend/        React + Vite + TS → nginx-unprivileged image
infra/terraform/ bootstrap · modules · envs/dev
local/ · docker-compose.yml · .github/workflows/ · docs/ · orchestration/
```
Image rules:
- All images ARM64, non-root, tagged with the git SHA (immutable).
- Trivy scan + SBOM on every build.
- Migrations run from the service image.
- One frontend image across envs (runtime `/config.js`).

### 7.5 Observability
- pino JSON logs with a correlation id, PII-redacted. X-Ray traces.
- Alarms:
  - 5xx rate
  - p95 latency
  - DLQ depth > 0
  - `EventPublishFailed`
  - evidence REJECTED spike
  - Aurora ACU at max
- CloudWatch dashboard per service. 7-day log retention (dev).

### 7.6 CI/CD (docs/09 §4)
| Pipeline | Trigger paths | PR stage | Main stage |
|---|---|---|---|
| `svc-auth` · `svc-users` · `svc-transactions` · `svc-disputes` | own folder + `backend/packages` + own OpenAPI + lockfile | lint, typecheck, unit, integration, contract, build, Trivy, SBOM | push ECR → ⏸ **approval** → migrate → ECS rollout (auto-rollback) → smoke |
| `lambda-evidence-intake` · `lambda-dispute-notifier` · `lambda-retention-sweeper` | own folder + packages + lockfile | same | push ECR → ⏸ approval → update function → publish version → alias `live` |
| `web` | `frontend/**` + `docs/openapi/**` | lint, typecheck, test, build, Trivy | push ECR → ⏸ approval → ECS rollout → smoke |
| `infra` | `infra/**` | fmt, validate, tflint, checkov, plan (PR comment) | plan → ⏸ approval → apply that plan |
| `contract` | `docs/openapi/**` | redocly lint + breaking-change diff | — |
| `e2e` | nightly + manual | API e2e + Playwright on the compose stack | — |

How the pipelines run:
- GitHub OIDC with one role per pipeline.
- Reusable `_build.yml` / `_deploy.yml` workflows.
- Approval through GitHub Environment `dev` (required reviewers; plan check V-04).
- Terraform ignores image versions, so pipelines own releases.

---

## 8. Delivery plan

Process: Claude orchestrates, and specialist agents implement one task each inside a fixed file boundary.
- **Gate:** test-engineer + code-standards-reviewer (+ security-reviewer on 🔒).
- **Milestone close:** integration-verifier checks the stated outcome.
- **Commits:** the orchestrator commits.

### M0 — Charter & verification ✅ done
- Specs 00–09, the OpenAPI contract, claim verification, adversarial peer review (16 findings accepted), 35 ADRs.

### M1 — Walking skeleton, local (27 tasks; C-04 done)
**Outcome:** with `docker compose up`, customer A completes the full flow in the browser and through the API:
- browse accounts → cards → transactions with `disputable` flags
- dispute with an evidence upload to (local) S3
- edit/withdraw
- disputes list → timeline

Also: customer B gets 404 on A's data, bad tokens get 401, service routes are invisible on 8080, and every PR pipeline is green.

| Wave | Tasks |
|---|---|
| 0 | F-01 monorepo tooling, catalog, boundary lint · C-04 ✅ OpenAPI · *V-03/V-04 verification* |
| 1 | S-01 shared + two-port servers · S-02 dispute-domain 🔒 · S-03 db runner · D-00 schemas/roles 🔒 · L-01 compose + mock issuer + moto · W-01 frontend scaffold + generated client + container · CI-01 PR pipelines |
| 2 | S-04 auth-client 🔒 · D-01 auth · D-02 users · D-03 transactions · D-04 disputes 🔒 migrations |
| 3 | D-05 seed · A-01 auth 🔒 · U-01 users 🔒 · T-01 transactions 🔒 · W-02 browse screens · W-03 dispute form + upload · W-04 disputes + timeline |
| 4 | P-01 create + upload URLs 🔒 → P-02 edit/withdraw 🔒 + P-03 list/detail/batch 🔒 · L-02 containers in compose |
| 5 | E-01 API e2e · W-05 Playwright UI smoke |

### M2 — Evidence pipeline, back-office, notifications, retention
**Outcome:**
- An uploaded file is scanned and shows as added or rejected on the timeline.
- The customer gets an email at every step.
- Unused upload slots expire; closed disputes' PII is erased after a year (proved with clock injection).
- Poison messages land in DLQs.

| Task | Agent |
|---|---|
| P-05 `POST …/evidence` (more uploads) + `PUT …/evidence/{evidenceId}` (scan result) 🔒 | service-api |
| P-06 publish-after-commit to the notifications queue + `EventPublishFailed` metric | service-api |
| L-03 evidence-intake Lambda (scan verdict, magic bytes, checksum, promote/delete, report) 🔒 | async-lambda |
| L-04 dispute-notifier Lambda (contact lookup, SES templates, DLQ) | async-lambda |
| L-05 retention-sweeper Lambda (EXPIRED slots, POPIA erasure via `disputes_retention`) 🔒 | async-lambda |
| W-06 web: evidence status updates, resolution note display, error/edge polish | frontend |
| E-02 e2e for the async flows (Lambda RIE + moto) | test-engineer |
| Fallback if GuardDuty S3 is unavailable (V-03): intake runs without the scan and flags "not scanned"; owner decides | — |

### M3 — Infrastructure & delivery (af-south-1)
**Outcome:**
- Everything in M1 + M2 passes against the deployed `dev` environment, with a real Cognito user, a real SES email and real S3/GuardDuty.
- Every deployable ships through its own pipeline with manual approval.

| Task | Agent |
|---|---|
| I-00 bootstrap: state bucket + lock, GitHub OIDC provider + per-pipeline roles | infra-terraform |
| I-01 network (2 AZs, 1 NAT, S3 gateway endpoint) · I-02 KMS + security groups | infra-terraform |
| I-03 Cognito (pool, hosted UI, resource server + scopes, customer-facing app clients) | infra-terraform |
| I-04 Aurora PG18 Serverless v2 + secrets + bootstrap roles | infra-terraform |
| I-05 ECR repos ×8 (lifecycle keep 10, immutable tags) · I-06 ECS cluster + Service Connect + `ecs-service` module ×5 | infra-terraform |
| I-07a DNS: delegated sub-zone <app-domain> + parent NS record, ACM certs (us-east-1 + af-south-1) · I-07 CloudFront (`/api/*` + default), strip function, WAF · I-08 ALB (HTTPS origin, CloudFront-only; internal listener 8081 for Lambdas) | infra-terraform |
| I-09 SQS + DLQ + alarms · I-10 quarantine/evidence buckets + GuardDuty + EventBridge | infra-terraform |
| I-11 container-image Lambdas ×3 + schedules · I-12 SES domain identity <app-domain> (DKIM, MAIL FROM, DMARC) · I-13 observability (dashboards, alarms) | infra-terraform |
| CI-02 deploy stages: approvals, migrations task, rollout/rollback, Lambda alias, infra apply | implementer |
| X-01 customer provisioning tool (Cognito user + app_user + auth_identity) for seed customers | implementer |
| E-03 e2e + Playwright against dev; evidence controls on real S3; first: confirm the Lambda Node 24 image in af-south-1 | test-engineer |

### M4 — Hardening
| Task |
|---|
| H-01 WAF tuning + per-user rate limits (dispute create, evidence, review queue) |
| H-02 Alarms → notification channel, runbooks per alarm |
| H-03 Full security review + threat-model refresh + dependency audit |
| H-04 Accessibility pass (WCAG 2.1 AA) on the web app |
| Deferred beyond the first release: row-level security, load testing, multi-env, DR, back-office UI |


### ⏸ Deferred — Back-office (owner schedules later)
| Task |
|---|
| P-04 `GET /review-queue`, `PUT …/review`, `PUT …/resolution` (AGENT only, expectedVersion) 🔒 |
| B-01 Agent identity (Cognito `agents` group) + access path (Q-17) 🔒 |
| Terraform: `svc-backoffice` client + `disputes/review`, `disputes/resolve` grants |
| Optional back-office UI |

---

## 9. Cost (dev, af-south-1, monthly, lower bound)
| Item | $ |
|---|---|
| Aurora Serverless v2 @ 0.5 ACU + storage | 64 |
| NAT gateway + IP + 10 GB | 46 |
| Fargate ARM: 4 services + web (5 × 0.25 vCPU / 0.5 GB) | 49 |
| ALB (CloudFront origin + 8081 listener for Lambdas) | ~36 |
| CloudFront (low dev traffic; price V-06) | ~1–5 |
| Route 53 hosted zone (sub-zone) | ~0.5–1 |
| WAF | 7 |
| Cognito M2M tokens | 6 |
| Secrets, KMS, CloudWatch logs | ~8 |
| ECR | ~2 |
| **Total** | **≈ $225** + GuardDuty S3 scanning (price V-03) + data transfer + GitHub plan/minutes (V-04) |

---

## 10. Risks
| Id | Risk | Mitigation |
|---|---|---|
| R-1 | GuardDuty S3 malware scanning not in af-south-1 | V-03 first. Fallback: magic-byte/checksum checks only, files flagged "not scanned"; owner decides |
| R-2 | Lambda Node 24 container image issues in af-south-1 | First M3 task proves it |
| R-3 | Best-effort events lose an email | Timeline is the truth; `EventPublishFailed` alarm; reinstate the outbox if emails become legal notices |
| R-4 | GitHub required reviewers need a paid plan on private repos | V-04. Fallback: a public repo, or an approval job gated on a protected-branch PR |
| R-5 | moto fidelity for S3 policies | Evidence controls re-tested on real S3 (E-03) |
| R-6 | SES sandbox limits delivery to verified recipients | Accepted for dev; request production access only if real customers are added |
| R-9 | Changing DNS for the existing site by mistake | Delegated sub-zone; Terraform's DNS permissions limited to the sub-zone + one parent NS record |
| R-7 | Single NAT = single-AZ egress | Accepted for dev |
| R-8 | transactions ↔ disputes runtime coupling | Service-port lookups make no calls; graceful degradation |

---

## 11. Decisions (current)
All ADRs, with superseded ones marked, are in `orchestration/state.json`. The ones that shape the product most:
- Cognito + central `/validate` (ADR-003/013).
- Two ports, the token decides (026).
- One dispute per transaction, ever; expired card blocks (020).
- Full amount only; dispute stores only its own data (024).
- No idempotency/outbox tables (023).
- Presigned uploads to quarantine (028).
- No automation changes status (016/033).
- Containers everywhere, including Lambdas (030).
- Per-deployable pipelines with manual approval (032).
- Window and reason codes confirmed (034).
- SES sender (035).

---

## 12. Open items
| Id | Item | Type | Needed by |
|---|---|---|---|
| Q-17 | Back-office access path — **deferred** with back-office | deferred | — |
| V-03 | Presigned PUT can sign `x-amz-checksum-sha256`; GuardDuty S3 in af-south-1 + price; presigner version | verification | before P-01 |
| V-04 | GitHub required reviewers on a private repo (plan?); Actions minutes; Lambda Node 24 base image; frontend library versions | verification | before CI-01 / W-01 |
| V-06 | CloudFront VPC origins in af-south-1 (optional: would make the ALB internal) + CloudFront/WAF/Route 53 pricing | verification | M3 |
| Q-18 | Is the `<owner-domain>` hosted zone in the same AWS account as the dev environment? (if not: 4 NS records added by hand once) | owner | deferred — domain work not a priority now (owner 2026-10-19); design ADR-037 kept for M3 |

The project folder is not yet a git repository. On "go M1": `git init` → initial commit → V-03/V-04/V-05 → wave 0.
