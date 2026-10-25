# Card Dispute Platform — Project Constitution

The contract every contributor and agent works under. Read before touching code.

## 1. What we are building

A card dispute platform. Authenticated customers see their accounts and masked cards, query their
card transactions, and raise, update or view a dispute against a transaction. Disputes wait in a
review queue and are reviewed and resolved only by a human back-office agent (no automation changes
status), and the customer is emailed on every status change. Delivered to AWS eu-north-1 (environment `dev`), built to
production patterns.

The one thing it must get right: **a customer can only ever see or dispute their own data**, and
every dispute state change is valid, auditable and never lost.

## 2. Stack (decided — do not relitigate without the owner)

| Layer | Choice |
|---|---|
| Language | TypeScript on Node.js 24 LTS (services and Lambdas — Lambdas as container images on the Node 24 Lambda base) |
| HTTP framework | Fastify, zod for validation |
| Services | 4 microservices on ECS Fargate: auth, users, transactions, disputes |
| Internal networking | ECS Service Connect; public traffic via WAF → ALB |
| Identity | Amazon Cognito user pool (user tokens) + client_credentials app clients (service tokens) |
| Database | Aurora PostgreSQL 18 Serverless v2 — one cluster, one schema + DB role per service |
| Async | Publish to SQS after DB commit (best-effort) → Lambda; DB is the source of truth |
| Files | Presigned PUT straight to an S3 quarantine bucket → scan → evidence-intake Lambda → evidence bucket (SSE-KMS). Disputes never handles file bytes |
| Email | SES via API (`@aws-sdk/client-sesv2`) |
| IaC | Terraform |
| Monorepo | pnpm workspaces: backend/* (Node 24), frontend (React + Vite); infra/ (Terraform) separate |
| Frontend | React + Vite + TypeScript SPA, nginx container on ECS; OIDC PKCE against Cognito |
| Containers | Everything is a container: services, frontend, migrations, **Lambdas (container images)**; ARM64; tag = git SHA |
| CI/CD | GitHub Actions, one pipeline per deployable, OIDC to AWS, **manual approval on every deploy** |
| Tests | vitest, testcontainers (Postgres 18), moto server for SQS/S3 locally (LocalStack needs a licence — Q-11); SES mocked at SDK boundary |
| Region | eu-north-1, single `dev` environment |

Hard rules the stack implies:
- No secret, credential or DB password in code, tfvars, images or logs. Secrets Manager only.
- No service reads another service's schema or imports another service's folder. Cross-service data goes over HTTP.
- frontend imports nothing from backend; it depends only on docs/openapi.
- Full PAN and CVV are never stored, logged or returned anywhere. Cards are `last4` + token.

## 3. Repo layout (full detail: docs/09-repo-and-delivery.md)

```
backend/                      Node 24 — one folder per deployable
  auth/ users/ transactions/ disputes/     src/ migrations/ test/ Dockerfile package.json
  lambdas/{evidence-intake,dispute-notifier,retention-sweeper}/   container-image Lambdas
  packages/{shared,auth-client,dispute-domain,db}/                                     shared libs, not deployable
frontend/                     React + Vite + TS SPA (nginx container); API types generated from docs/openapi
infra/terraform/              bootstrap/, modules/*, envs/dev
docs/                         specs; docs/openapi/*.yaml = API contract (lint-clean)
local/                        mock-issuer, seed, moto init
docker-compose.yml            whole stack locally
.github/workflows/            one pipeline per deployable + reusable _build/_deploy
orchestration/  .Codex/
```

## 4. Non-negotiable engineering rules

1. **Pure dispute core.** All dispute state transitions and eligibility rules live in
   `backend/packages/dispute-domain`. No I/O, no `Date.now()` (time is injected). Runs in tests with zero mocks.
2. **Single source of truth.** Dispute window, reason codes, transition table, auto-rule thresholds
   are defined in `dispute-domain` only. Services and Lambdas import them; never re-derive.
3. **Validate at every boundary.** HTTP input, inter-service responses, SQS messages, S3 events,
   DB rows mapped to domain — parse with zod, don't assume.
4. **Server is authoritative for ownership.** The caller's identity comes only from the token
   validated by auth `/validate`. Every query is scoped by that identity. A client-supplied
   `userId` is never trusted on a user route. Other users' resources return 404, not 403.
5. **Two ports, token decides.** Customer routes live only on the public port (user principal required);
   service routes live only on the service port (service principal + scope required). No `/internal` prefix,
   and no header is ever trusted for access (ADR-026).
6. **The DB is the source of truth; events are side effects.** Publish after commit. Never make a
   correctness guarantee depend on an event arriving. Anything a user must see is read from the DB.
7. **Every consumer tolerates duplicates and reordering** without tracking tables, and has a DLQ.
8. **Every task ships with tests — useful ones only** (ADR-040, docs/10 §7). Each acceptance criterion and each real risk
   gets an executing test; nothing else. No coverage-% targets, no tests of framework/library behaviour, no
   per-endpoint repetition of auth cases already proven centrally.
9. **Feature-flag anything half-built.**
10. **Functional architecture, no classes** (ADR-038, docs/10).
    - Functional core / imperative shell: pure core, `(deps) => (input) => Result` use-cases, factory-function
      adapters, thin routes/handlers, one composition root (`main.ts`).
    - No `class` in our code. Immutable `readonly` data and discriminated unions.
    - Expected failures are `Result` values, not exceptions. Dependencies (incl. clock) are injected.
    - React uses function components + hooks. Lint enforces this.
11. **Comments are rare and short** (ADR-045). Names and types explain *what*; a comment only explains a non-obvious
    *why* (a constraint, a workaround, a security reason), in one line. No restating code, no banner/section
    comments, no commented-out code, no JSDoc on internal functions.

## 5. Commands

```bash
pnpm install
pnpm dev               # docker compose up + services in watch mode
pnpm -r test           # unit + integration (testcontainers)
pnpm -r typecheck
pnpm -r lint
pnpm test:e2e          # end-to-end against local stack
terraform -chdir=infra/terraform/envs/dev validate
```

## 6. Orchestrator protocol

Full process in `docs/07-agentic-workflow.md`. Short version:

- Backlog in `orchestration/backlog.md`, state in `orchestration/state.json`.
- No task is implemented before it is decomposed with acceptance criteria.
- One task = one agent = one file boundary (`owns`). Parallel agents never share files.
- Every implementation is gated by test-engineer + code-standards-reviewer before `done`;
  security-reviewer is mandatory for auth, auth-client, disputes, IAM and anything handling input.
- integration-verifier runs at milestone end against the milestone's stated outcome.
- No agent commits. The orchestrator commits.
- Report honestly: a failing test is reported as failing, with output.

## 7. Domain guardrails

| Guardrail | Enforcement point |
|---|---|
| Customer sees only own accounts, cards, transactions, disputes | Ownership predicate in every repository query; e2e negative tests per endpoint |
| No PAN/CVV anywhere | Schema has no such column; log redaction list in `backend/packages/shared`; seed review |
| PII (name, email, phone) not in logs | pino redact paths in `backend/packages/shared/logging` |
| Dispute history is immutable | `dispute_status_history` is insert-only (DB role has no UPDATE/DELETE on it) |
| Financial rows never hard-deleted | No DELETE grant on transaction/dispute tables for service roles |
| One dispute per transaction, ever (incl. withdrawn) | `unique (transaction_id)` + `evaluateTransactionEligibility` (ADR-020) |
| UI dispute button and backend agree | transactions computes `disputable` with `evaluateTransactionEligibility` (same function `POST /dispute` uses); the UI only renders the flag and never imports backend code (ADR-021) |
| Public repository (ADR-041) | No secrets, real PII or internal hostnames in git; secret scanning + push protection on; fork PRs get no secrets; deploy roles trust only `main` + environment `dev` |
| Dispute window and eligibility | `dispute-domain` rules, injected clock, table-driven tests |
| Evidence uploads are bounded and untrusted | Presigned URL signs type, length and sha256; quarantine bucket + malware scan + magic-byte check before promotion; ≤ 5 per dispute (ADR-028) |
| Services never handle evidence bytes | Disputes only signs URLs; only evidence-intake reads quarantine (IAM) |
| Emails only to the dispute owner | Notifier looks up recipient by `user_id`; never from message body |
