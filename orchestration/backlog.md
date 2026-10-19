# Backlog — Milestone M1: Walking skeleton (local)

**Stated outcome (what `integration-verifier` tests against):**
> On a developer machine, `pnpm dev` (`docker compose up`) brings up Postgres 18, moto (SQS/S3), a mock Cognito-shaped token
> issuer, all four services and the frontend, each as a container. Using a token from the mock issuer, seeded customer A can call
> `GET /me` and see their accounts with masked cards, call `GET /transactions` filtered by one of
> those cards, see a `disputable` flag on every transaction (false with a reason for expired cards, already-disputed, non-posted or out-of-window transactions), raise a dispute with `POST /dispute/{transactionId}`, edit it and withdraw it with
> `PUT /dispute/{transactionId}`, list their disputes with `GET /disputes`, and see a dispute's timeline with `GET /dispute/{transactionId}`. A transaction that was ever disputed (even withdrawn) cannot be disputed again, and a dispute on an expired card is rejected with `CARD_EXPIRED`. Customer B gets 404 on every one of A's transactions and disputes.
> An invalid or expired token gets 401. A user token on `GET /cards` gets 403; a service token with
> `users/cards.read` gets 200. The same flow works **in the browser** through the React app (login via the mock
> issuer, accounts → cards → transactions → dispute with an evidence upload → disputes timeline). Everything runs
> as containers from `docker compose up`, and every deployable's PR pipeline is green. The API e2e suite and the
> Playwright UI smoke test prove all of this.

`agent:` defaults to `implementer` where unspecified. Security gate required where marked 🔒.

---

## Wave 0 — foundation

### F-01 · Set up pnpm monorepo tooling
```yaml
agent: implementer
owns: [package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, eslint.config.js, .prettierrc, vitest.workspace.ts, .gitignore, .dockerignore, .nvmrc, .editorconfig, tools/lint-rules-test/**]
depends_on: []
acceptance:
  - pnpm-workspace.yaml defines a `catalog:` with every dependency at the version in docs/06-infra "Verified versions" (incl. @aws-sdk/client-s3, @aws-sdk/s3-request-presigner — verify first), (fastify, zod 4, vitest, pino, aws-jwt-verify, pg, @testcontainers/postgresql, node-pg-migrate, @aws-sdk/client-sqs, @aws-sdk/client-s3, @aws-sdk/client-sesv2, aws-sdk-client-mock)
  - after F-01, pnpm-lock.yaml is owned by the orchestrator only — implementers reference `catalog:` deps and never add a new dependency; needing one = stop and report (PR-01 K: no lockfile collisions between parallel agents)
  - pnpm-workspace includes backend/packages/*, backend/auth, backend/users, backend/transactions, backend/disputes, backend/lambdas/*, frontend, tests/* (infra/ excluded) [ADR-029]
  - catalog also pins the frontend deps (react, react-dom, vite, @vitejs/plugin-react, react-router, an OIDC PKCE client, openapi-typescript, @testing-library/react, playwright) — versions via /verify-claims first
  - eslint functional rules per docs/10 §6: ClassDeclaration/ClassExpression banned in backend/ and frontend/; no-param-reassign; Date.now banned in core/ and dispute-domain; core/ ↛ adapters, use-cases ↛ adapters, only main.ts imports adapters (lint test proves each violation fails) [ADR-038]
  - eslint boundary rule: a backend service may import only backend/packages/*; frontend may import nothing from backend/ (lint test proves a violation fails)
  - root scripts exist: dev, test, typecheck, lint, test:e2e, seed:local; each runs `pnpm -r` or the documented command
  - tsconfig.base enables strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, NodeNext modules
  - .nvmrc pins the Node major verified in orchestration/verify-claims-01.md
  - `pnpm install && pnpm -r typecheck && pnpm lint` exit 0 on the empty workspace
```

## Wave 1 — depends on F-01, fully parallel

### S-01 · Build backend/packages/shared (config, errors, logging, correlation)
```yaml
agent: implementer
owns: [backend/packages/shared/**]
depends_on: [F-01]
acceptance:
  - loadConfig(schema) parses process.env with zod and throws listing every missing/invalid key
  - problem+json error helpers produce RFC 9457 bodies with type,title,status,detail,code,correlationId
  - `@cd/shared/fp`: Result/ok/err/map/flatMap/assertNever exactly as docs/10 §3, with tests [ADR-038]
  - createServers({ public, service }) starts two Fastify instances on PUBLIC_PORT (8080) and SERVICE_PORT (8081); health/ready on both; test: a route registered on one port returns 404 on the other [ADR-026]
  - Fastify plugin sets/echoes x-correlation-id and attaches it to every log line; inbound ids not matching ^[A-Za-z0-9-]{8,64}$ are replaced (test with CRLF injection)
  - logger redacts authorization, token, email, cellphoneNumber, name, surname, *.secret, password — test asserts redacted output from a sample object
  - money helpers compare/add decimal strings without float (test: "0.10"+"0.20" == "0.30"; "100.00" <= "100.00")
```

### S-02 · Implement backend/packages/dispute-domain 🔒
```yaml
agent: dispute-domain
owns: [backend/packages/dispute-domain/**]
depends_on: [F-01]
acceptance:
  - exports REASON_CODES, DISPUTE_WINDOW_DAYS=120, transition table per docs/04
  - evaluateTransactionEligibility(txn, card, existingDispute, now) returns {allowed, reason?} with the first failing code in docs/04 order: ALREADY_DISPUTED (any status incl. WITHDRAWN), CARD_EXPIRED, TXN_NOT_POSTED, TXN_TYPE_NOT_DISPUTABLE, OUTSIDE_WINDOW [ADR-020/021]
  - validateDisputeInput(input) returns ok | INVALID_REASON | INVALID_DESCRIPTION; there is no amount input (no partial disputes, ADR-024)
  - isCardExpired(card, now): expiry 09/2028 → valid at 2028-09-30T23:59:59.999Z, expired at 2028-10-01T00:00:00Z; BLOCKED/CANCELLED status alone never makes eligibility fail
  - window boundary tests: posted 120 days ago → ok; 121 days → OUTSIDE_WINDOW (UTC whole days)
  - REFUND txn → TXN_TYPE_NOT_DISPUTABLE; PENDING/DECLINED/REVERSED → TXN_NOT_POSTED
  - applyAction(dispute, action, actor) covers every (state × action × actorType) cell; terminal states reject every action with INVALID_TRANSITION; USER cannot REVIEW/RESOLVE; SYSTEM_RULE/AGENT cannot EDIT
  - re-applying an already-applied REVIEW/RESOLVE is a no-op success
  - REVIEW and RESOLVE allowed only for actorType AGENT; SYSTEM_RULE may change no dispute status (ADR-016, ADR-033)
  - imports only zod and @cd/shared/fp — no node built-ins (enforced by the F-01 purity lint rule; nothing extra to test)
  - each eligibility rule and each transition-table row has exactly one table entry (incl. 120/121-day and month-end expiry boundaries); no coverage-% target (ADR-040)
```

### S-03 · Build backend/packages/db (migration runner + test helpers)
```yaml
agent: implementer
owns: [backend/packages/db/src/**, backend/packages/db/test/**, backend/packages/db/package.json, backend/packages/db/tsconfig.json]
depends_on: [F-01]
acceptance:
  - migrate(schemaName, dir, connection) applies SQL files in order, recorded in <schema>.schema_migrations; re-run is a no-op
  - startTestPostgres() helper (testcontainers) returns a connection string and a teardown; used by its own test
  - withTransaction(pool, fn) commits on success, rolls back on throw (tested)
  - migration tool choice (node-pg-migrate or minimal custom) recorded in the task report with reason
```

### D-00 · Write DB bootstrap: schemas, roles, grants, updated_at trigger 🔒
```yaml
agent: data-schema
owns: [backend/packages/db/bootstrap/**]
depends_on: [F-01]
acceptance:
  - creates schemas auth, users, transactions, disputes; for each a <svc>_migrator (DDL on own schema) and <svc>_app (DML on own schema) role
  - also creates role disputes_retention (no default privileges; column grants come from D-04) [PR-DB-2]
  - creates extension citext; function <schema>.set_updated_at() in each schema
  - test (testcontainers): users_app cannot SELECT from transactions.*; disputes_app cannot SELECT from users.*
  - passwords come from env, never literals in SQL
```

### C-04 · Write OpenAPI 3.1 specs for all services
```yaml
agent: implementer
owns: [docs/openapi/**]
status: DONE 2026-10-11 by orchestrator — 8 files (common + public/service per service), `redocly lint` 0 errors / 0 warnings
depends_on: []
acceptance:
  - every route in docs/02-api.md "Route exposure" table present with request/response schemas, auth requirement and all listed error statuses
  - specs lint clean with @redocly/cli lint (output in report)
  - any contradiction with docs/02-api.md reported, not resolved silently
```

### L-01 · Create local stack: compose + mock token issuer
```yaml
agent: implementer
owns: [docker-compose.yml, local/mock-issuer/**, local/.env.example, local/README.md]
depends_on: [F-01]
acceptance:
  - compose runs postgres:18, moto server (sqs, s3) and mock-issuer only (service containers come in L-02 — PR-01 K: Dockerfiles don't exist yet)
  - mock-issuer also issues the client_credentials tokens services use to call /validate (scope auth/validate)
  - moto creates the quarantine and evidence buckets at startup
  - mock-issuer serves /.well-known/jwks.json and issues RS256 Cognito-shaped access tokens: user tokens (sub, username, token_use=access, client_id, iss, exp) and client_credentials tokens (client_id, scope, token_use=access)
  - mock-issuer can mint expired and wrong-issuer tokens for negative tests
  - fixed seed users A and B with stable subs documented in local/README.md
```

## Wave 2 — depends on Wave 1

### S-04 · Build backend/packages/auth-client 🔒
```yaml
agent: implementer
owns: [backend/packages/auth-client/**]
depends_on: [S-01]
acceptance:
  - Fastify plugin extracts Bearer token; missing/malformed → 401 problem+json
  - calls AUTH_URL/validate; caches valid results until min(exp, 60s); never caches invalid results
  - requireUser() rejects service principals with 403; requireService(scope) rejects user principals and missing scope with 403
  - helpers to apply requireUser() to every route on the public instance and requireService() to every route on the service instance by default (a route can't be registered unguarded)
  - getServiceToken(clientId, secret, scopes) fetches client_credentials token from TOKEN_URL and caches until 60s before exp; test proves N concurrent calls → 1 token request (Cognito bills per request)
  - auth service unreachable → 503, never fail-open (test)
  - HTTP client helper forwards x-correlation-id and has 2s timeout
```

### D-01 · Write auth schema migrations
```yaml
agent: data-schema
owns: [backend/auth/migrations/**]
depends_on: [S-03, D-00]
acceptance:
  - auth_identity per docs/03 with UQ on auth_id, cognito_sub, username; status CHECK
  - auth_identity also has user_id uuid UQ not null (logical ref → users.app_user.user_id, ADR-007)
  - migration applies cleanly on testcontainers (test in backend/auth/migrations/test)
```

### D-02 · Write users schema migrations
```yaml
agent: data-schema
owns: [backend/users/migrations/**]
depends_on: [S-03, D-00]
acceptance:
  - app_user (not `user` — reserved word, PR-01 F6), account, card per docs/03 incl. all CHECKs, UQs, FKs, indexes, updated_at triggers
  - no column can hold a full PAN (last4 char(4) CHECK digits)
  - card.status CHECK excludes EXPIRED; expiry_month 1–12 and expiry_year 2000–2100 CHECKs; FKs ON DELETE RESTRICT (test: deleting an account with cards fails) [PR-DB-4/7/10]
  - constraint tests: bad E.164 rejected; last4 'abcd' rejected; duplicate token rejected
```

### D-03 · Write transactions schema migrations
```yaml
agent: data-schema
owns: [backend/transactions/migrations/**]
depends_on: [S-03, D-00]
acceptance:
  - transaction per docs/03 with the three listed indexes; amount > 0 CHECK; status/type CHECKs
  - transactions_app has no DELETE privilege (test)
  - CHECK: POSTED row without posted_at rejected [PR-DB-7]
```

### D-04 · Write disputes schema migrations 🔒
```yaml
agent: data-schema
owns: [backend/disputes/migrations/**]
depends_on: [S-03, D-00]
acceptance:
  - dispute, dispute_status_history, dispute_evidence exactly per docs/03 (no idempotency_key/outbox/processed_event, no amount or transaction snapshot columns — ADR-023/024)
  - unique (transaction_id) on dispute: a second dispute for the same transaction fails in every case, including after WITHDRAWN or RESOLVED_* [ADR-020]
  - index (user_id, updated_at desc, dispute_id desc) for GET /disputes paging
  - history has action (closed CHECK list) + before/after jsonb and no updated_at [PR-DB-8/9]
  - CHECKs reject: description < 10 chars, unknown reason/status, resolved_at inconsistent with status [PR-DB-6]
  - evidence status CHECK is PENDING | STORED | REJECTED | EXPIRED | ERASED, rejection_reason only when REJECTED, s3_key only when STORED (ADR-028); role disputes_retention can UPDATE only history (note, before, after) — test: UPDATE of history.to_status as disputes_retention fails, as disputes_app any UPDATE fails [PR-DB-2/3]
  - FKs ON DELETE RESTRICT [PR-DB-10]
  - disputes_app cannot UPDATE or DELETE dispute_status_history, cannot DELETE dispute (tests)
```

## Wave 3 — depends on Wave 2

### D-05 · Generate mock seed data
```yaml
agent: data-schema
owns: [local/seed/**]
depends_on: [D-01, D-02, D-03, D-04, L-01]
acceptance:
  - deterministic (fixed RNG seed): users A, B, C matching mock-issuer subs; 1–2 accounts each; 1–2 cards each; ~200 transactions each over last 180 days
  - includes for user A: a POSTED txn at 119 days, one at 121 days, a PENDING, a DECLINED, a REFUND, and a duplicate pair (same merchant/amount within 48h)
  - transaction.user_id/account_id/card_id match the users seed
  - user A also has disputes seeded directly in UNDER_REVIEW, RESOLVED_ACCEPTED (with resolution note) and RESOLVED_REJECTED with history rows, so the customer timeline is testable while back-office is deferred (ADR-039)
  - user A also has: one expired card (expiry_month/year = last month; status stays ACTIVE — expiry is derived) with recent POSTED txns; one txn with a seeded WITHDRAWN dispute (disputes schema) so ALREADY_DISPUTED and CARD_EXPIRED are visible in e2e
  - seeds auth.auth_identity (ACTIVE, with user_id) and users.app_user (with auth_id) for A, B, C following the provisioning order in docs/03; plus user D with auth_identity DISABLED for negative tests [PR-01 F7, K]
  - `pnpm seed:local` is idempotent (second run changes nothing)
  - fake names, example.com emails only
```

### A-01 · Implement auth service — POST /validate 🔒
```yaml
agent: service-api
owns: [backend/auth/src/**, backend/auth/test/**, backend/auth/package.json, backend/auth/tsconfig.json, backend/auth/Dockerfile]
depends_on: [S-01, D-01, L-01, C-04]
acceptance:
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm deploy`), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint for the migration task; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
  - verifies JWT via JWKS (aws-jwt-verify or equivalent per verify-claims), with configurable issuer + client_id allow-list
  - caller must present its own service token with scope auth/validate (verified locally); missing → 401, user token as caller or wrong scope → 403 [PR-01 F4]
  - /validate is registered on the service port only; the public port of auth registers no business routes
  - returns principalType user with authId+userId for a known ACTIVE sub; unknown sub → valid:false unknown_subject; DISABLED → valid:false disabled
  - returns principalType service with scopes for client_credentials tokens
  - negative tests each produce their reason: expired, bad_signature, wrong_issuer, wrong_client, wrong_token_use (id token)
  - malformed body → 400; /health and /ready (ready checks DB) exist
  - userId comes from auth_identity.user_id (ADR-007); auth makes no call to users
```

### U-01 · Implement users service — GET /me, GET /cards, GET /users/{userId}/contact 🔒
```yaml
agent: service-api
owns: [backend/users/src/**, backend/users/test/**, backend/users/package.json, backend/users/tsconfig.json, backend/users/Dockerfile]
depends_on: [S-02, S-04, D-02, C-04]
acceptance:
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm deploy`), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint for the migration task; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
  - GET /me returns profile + accounts + cards for the caller; every card has `expired` computed by isCardExpired from @cd/dispute-domain (no local date logic — grep test); never includes card token (test asserts key absent)
  - GET /cards: user token → 403; service token without users/cards.read → 403; with scope → 200 filtered by userId/accountId/cardId, includes `expired`; missing userId → 400
  - contact endpoint requires users/contact.read
  - no auth → 401 on every route except health
```
### T-01 · Implement transactions service — GET /transactions (+ disputable) and internal raw lookup 🔒
```yaml
agent: service-api
owns: [backend/transactions/src/**, backend/transactions/test/**, backend/transactions/package.json, backend/transactions/tsconfig.json, backend/transactions/Dockerfile]
depends_on: [S-02, S-04, D-03, C-04]
acceptance:
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm deploy`), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint for the migration task; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
  - every query includes user_id = principal.userId (test: user B with A's cardId/transactionId → empty items)
  - all filters from docs/02 work; no filter = all accounts; from>to, min>max, bad uuid, limit>100 → 400
  - cursor pagination is stable: walking all pages returns every row exactly once with ties on transactionAt
  - every item has `dispute` and `disputable`, computed with evaluateTransactionEligibility from @cd/dispute-domain using users GET /cards (cached 60s per user) and disputes GET /disputes (service port) (one batch call per page) — tests use an HTTP stub for both
  - users or disputes down / >2s → page still 200, every item disputable {allowed:false, reason:UNAVAILABLE}, dispute null (test)
  - GET :8081/transactions?userId=&transactionIds=&accountId?&cardId? (≤100 ids): service token with transactions/read only; returns only that user's raw rows matching the optional account/card filter; makes NO outbound s2s calls (test asserts stubs not called) [ADR-025]
  - user tokens on the internal route → 403; service tokens on the public list → 403
  - amounts serialised as decimal strings
```
## Wave 4

### P-01 · Implement disputes service skeleton + POST /dispute/{transactionId} 🔒
Split from the original P-01 after PR-01 K (too big, alone on critical path).
```yaml
agent: service-api
owns: [backend/disputes/src/app.ts, backend/disputes/src/server.ts, backend/disputes/src/config.ts, backend/disputes/src/clients/**, backend/disputes/src/repo/**, backend/disputes/src/routes/create.ts, backend/disputes/src/routes/index.ts, backend/disputes/test/create.test.ts, backend/disputes/test/helpers/**, backend/disputes/package.json, backend/disputes/tsconfig.json, backend/disputes/Dockerfile]
depends_on: [S-02, S-04, D-04, C-04]
acceptance:
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm deploy`), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
  - POST fetches txn via transactions GET :8081/transactions?userId=<principal>&transactionIds=<id> (service token) and card via users GET /cards (service token); not found/not owned → 404 [ADR-020: card expiry blocks]
  - eligibility decided only by evaluateTransactionEligibility + validateDisputeInput from @cd/dispute-domain with now = DB now() from the same transaction (no rule literals in service code — grep test for "120")
  - one DB transaction writes dispute + history; a forced failure after the dispute insert leaves no rows
  - after commit, publishes DisputeCreated to both queues via an injected publisher; publish failure is logged + metric and does NOT change the 201 (test with a failing stub)
  - retried / concurrent POSTs for the same transaction → exactly one 201, the rest 409 ALREADY_DISPUTED (unique constraint; test with 5 parallel requests)
  - any existing dispute (any status) → 409 ALREADY_DISPUTED; expired card → 422 CARD_EXPIRED; concurrent POSTs with different keys → exactly one 201 (unique constraint)
  - user B on A's transaction → 404; event payload contains no PII and carries version
  - body with disputedAmount (or any unknown field) → 400 — partial disputes impossible [ADR-024]
  - POST is JSON with optional 0–5 evidence declarations; 201 returns one presigned PUT per declaration for the quarantine bucket, with Content-Type, Content-Length and x-amz-checksum-sha256 signed, 10-minute expiry [ADR-028]
  - signer (verify-claims-02 #1): PutObjectCommand with ChecksumSHA256 = base64(raw 32-byte digest) converted from the declared hex; getSignedUrl with `unhoistableHeaders: {x-amz-checksum-sha256}` and `signableHeaders: {content-type, content-length}`; the returned `headers` match exactly; test asserts the URL query has no checksum parameter and X-Amz-SignedHeaders lists all three
  - test against moto: uploading with the signed headers succeeds; a different Content-Type, length or checksum is rejected by S3
  - 6 declarations, size > 10 MB, type not PDF/JPEG/PNG, malformed sha256 → 400; no dispute or evidence rows written
  - evidence rows created PENDING in the same transaction as the dispute; the presigned key never contains the client filename
  - the disputes task never reads or writes object bytes (code review + IAM test in M3)
  - repo exposes lockForUpdate(disputeId|transactionId,userId), updateWithVersion() and findLatestWithHistory() for P-02/P-03; routes/index.ts registers update.ts, get.ts, list.ts (public port) and service.ts (service port) placeholders (501)
```

### P-02 · Implement PUT /dispute/{transactionId} (edit / withdraw) 🔒
```yaml
agent: service-api
owns: [backend/disputes/src/routes/update.ts, backend/disputes/test/update.test.ts]
depends_on: [P-01]
acceptance:
  - targets caller's active dispute; none / not owned → 404
  - If-Match missing → 428; stale → 412; EDIT only in SUBMITTED; WITHDRAW in SUBMITTED/UNDER_REVIEW; terminal → 409 INVALID_TRANSITION
  - row locked FOR UPDATE; two concurrent PUTs with same If-Match → one 200, one 412
  - EDIT writes history with before/after of changed fields and publishes DisputeEdited after commit; WITHDRAW writes DisputeStatusChanged
  - edit re-validates reason/description via validateDisputeInput; disputedAmount in body → 400
  - needs a file outside owns (e.g. route registration in routes/index.ts)? stop and report — P-01 must register update.ts as a placeholder route
```

### P-03 · Implement GET /disputes, GET /dispute/{transactionId} (timeline), GET /disputes (service port) 🔒
Owner UI flow 2026-10-10: disputes view with timeline; transactions needs dispute state per page.
```yaml
agent: service-api
owns: [backend/disputes/src/routes/get.ts, backend/disputes/src/routes/list.ts, backend/disputes/src/routes/service.ts, backend/disputes/src/timeline.ts, backend/disputes/test/get.test.ts, backend/disputes/test/list.test.ts, backend/disputes/test/service.test.ts]
depends_on: [P-01]
acceptance:
  - GET /disputes lists only the caller's disputes, filters status/accountId/cardId; account/card resolved via transactions internal lookup (chunks of 100, test with 150 disputes); cursor paging by updatedAt desc stable across ties; includes lastEvent [ADR-025]
  - account/card filter with transactions down → 503; unowned accountId/cardId → empty list
  - list and detail attach `transaction` via ONE GET /transactions (service port) batch call per response; transactions down → transaction:null, still 200
  - GET /dispute/{transactionId} returns the resource + ascending timeline built from history + evidence rows; types limited to the docs/02 list; `by` is CUSTOMER|BANK only — test asserts no agent id or actor_id string appears in the response body
  - none / not owned → 404; user B on A's transaction → 404; ETag = version
  - GET :8081/disputes?userId=&transactionIds=: service token with disputes/read only; >100 ids → 400; returns only that user's disputes; makes no outbound s2s calls
```
### L-02 · Add service containers to local stack
```yaml
agent: implementer
owns: [docker-compose.services.yml]
depends_on: [A-01, U-01, T-01, P-01, L-01, W-01]
acceptance:
  - compose override builds the 4 services and the frontend (published on :5173); only port 8080 of users/transactions/disputes is published to the host; every 8081 stays on the internal network (test: host request to 8081 fails)
  - services wait on postgres healthy + migrations job; `pnpm dev` (compose -f both files) brings everything up and all /ready return 200
```

### W-01 · Scaffold frontend app (Vite + React + TS) with generated API client and container
```yaml
agent: frontend
owns: [frontend/package.json, frontend/tsconfig.json, frontend/vite.config.ts, frontend/index.html, frontend/src/main.tsx, frontend/src/app/**, frontend/src/api/**, frontend/src/auth/**, frontend/src/config.ts, frontend/nginx.conf, frontend/Dockerfile, frontend/docker-entrypoint.sh, frontend/test/setup.ts]
depends_on: [F-01, C-04]
acceptance:
  - API types generated from docs/openapi/*.public.yaml by a script (`pnpm --filter @cd/web gen:api`); CI fails if the generated output is stale
  - OIDC authorization code + PKCE login against a configurable issuer (mock-issuer locally, Cognito in dev); tokens kept in memory only (test asserts nothing in localStorage)
  - runtime config from /config.js written by the container entrypoint from env vars (one image for all envs); API base path `/api` (vite dev proxy strips it locally, CloudFront in dev)
  - nginx: SPA fallback, strict CSP (connect-src 'self' + S3 quarantine origin; API is same-origin under /api — ADR-036/037), no server tokens; image runs as non-root; Trivy clean
  - app shell with routes for Home, Account, Card, Dispute form, Disputes list, Dispute detail (placeholders)
```

### W-02 · Build accounts → cards → transactions screens
```yaml
agent: frontend
owns: [frontend/src/screens/home/**, frontend/src/screens/account/**, frontend/src/screens/card/**, frontend/src/components/transactions/**, frontend/test/transactions/**]
depends_on: [W-01]
acceptance:
  - Home: accounts with masked cards from GET /me + recent transactions (GET /transactions); expired cards visibly marked from `expired`
  - Account: its cards (no extra call) + GET /transactions?accountId=; Card: GET /transactions?cardId=; infinite scroll on nextCursor
  - each row shows dispute status if `dispute` is present; Dispute button only when disputable.allowed; otherwise a human message per reason (incl. UNAVAILABLE "temporarily unavailable")
  - component tests for loading/empty/error and every disputable.reason
```

### W-03 · Build dispute form with evidence upload
```yaml
agent: frontend
owns: [frontend/src/screens/dispute-form/**, frontend/src/lib/upload/**, frontend/test/dispute-form/**]
depends_on: [W-01]
acceptance:
  - form: reason (7 codes), description (10–2000), optional 0–5 files; client-side checks on type (PDF/JPEG/PNG), size ≤ 10 MB, count ≤ 5
  - SHA-256 computed with Web Crypto; POST /dispute/{transactionId} with declarations; each file PUT to its upload URL with exactly the returned headers; per-file progress + retry of a failed upload by re-requesting URLs via POST /dispute/{id}/evidence
  - 409 ALREADY_DISPUTED → navigate to the existing dispute; 422 → reason message
  - no amount field anywhere (full-amount disputes)
```

### W-04 · Build disputes list + timeline + edit/withdraw
```yaml
agent: frontend
owns: [frontend/src/screens/disputes/**, frontend/src/screens/dispute-detail/**, frontend/test/disputes/**]
depends_on: [W-01]
acceptance:
  - list from GET /disputes with status/account/card filters + paging; transaction null → "details unavailable"
  - detail: timeline (by CUSTOMER/BANK), evidence with statuses (PENDING/STORED/REJECTED/EXPIRED), add-evidence entry
  - edit (only SUBMITTED) and withdraw with an explicit warning that it is final; If-Match from ETag; 412 → reload + message
```

### CI-01 · Create per-deployable PR pipelines (verify stage)
```yaml
agent: implementer
owns: [.github/workflows/**]
depends_on: [F-01]
acceptance:
  - reusable _build.yml (lint, typecheck, unit, integration, contract tests, docker build, Trivy, SBOM) used by svc-auth, svc-users, svc-transactions, svc-disputes, lambda-* (4), web, plus contract.yml (redocly lint + breaking-change diff) and infra.yml (fmt/validate/tflint/checkov/plan with backend=false until M3)
  - path filters exactly as docs/09 §4.1; shared-package change triggers all dependents (proved by a dry-run listing in the PR)
  - no AWS credentials in M1 (verify stage only); deploy jobs + approvals are added in M3 (CI-02)
  - every workflow uses least-privilege `permissions:`, pinned action SHAs, `concurrency`
  - public-repo hardening per docs/09 §6: only `pull_request` (no `pull_request_target`), no secrets/OIDC on fork runs, secret scan (gitleaks or equivalent, version verified) on every PR, ARM64 builds on `ubuntu-24.04-arm` [ADR-041]
```

## Wave 5

### E-01 · Write end-to-end suite for M1 outcome
```yaml
agent: test-engineer
owns: [tests/e2e/**]
depends_on: [A-01, U-01, T-01, P-01, P-02, P-03, D-05, L-02]
acceptance:
  - one test per sentence of the M1 stated outcome, running against `pnpm dev` stack via public ports only
  - auth negatives are NOT repeated per endpoint (proven once in S-04/A-01). E2E checks only: one 401 (no token) and one service-token→403 on the public port; user B → 404 on one representative endpoint per service; one service-only path on the public port → 404 (ADR-040)
  - UI-flow test: /me → pick account → /transactions?accountId → pick card → /transactions?cardId → dispute a disputable row → row now shows dispute + allowed:false ALREADY_DISPUTED → /disputes lists it → timeline shows SUBMITTED; withdraw → re-POST → 409; expired-card row shows CARD_EXPIRED and POST → 422
  - `pnpm test:e2e` exits 0; output attached to milestone report

### W-05 · Write Playwright UI smoke test for the full flow
```yaml
agent: test-engineer
owns: [tests/ui/**]
depends_on: [W-02, W-03, W-04, L-02, D-05]
acceptance:
  - against docker compose: login as A → account → card → dispute a disputable row with a PDF → row shows the dispute → disputes list → timeline shows SUBMITTED; expired-card row has no button; withdraw shows the warning
  - runs headless in CI (e2e.yml)
```
```

---

## Deliberately deferred to M2/M3
- SQS consumers (Lambdas), SES, add-evidence-later endpoint, review/resolution endpoints → M2 (M1: create returns upload URLs, evidence stays PENDING; intake in M2) (event path needs the M1 write path first).
- Terraform, CD deploy stages with manual approval (CI-02), real Cognito → M3 (local mock issuer is enough to prove the API contract).
- WAF, alarms → M4.

### Accepted PR-01 findings logged for later milestones
| Id | Finding | Milestone |
|---|---|---|
| PR-01-F2 | expectedVersion on review/resolution (auto-decide dropped by ADR-016) | M2 |
| PR-01-F3 | internal ALB for Lambda → service port 8081 (Terraform + SG) | M2 design, M3 infra |
| PR-01-ord | events carry version; notifier skips stale versions | M2 |
| PR-01-mal | evidence malware scanning (verify GuardDuty S3 in af-south-1) | M2 |
| PR-01-bo | back-office human identity (Cognito `agents` group) | M2 |
| PR-01-rl | per-user rate limits on dispute create / evidence | M4 |
| PR-01-lag | EventPublishFailed alarm, Lambda reserved concurrency | M2/M4 |
| PR-01-rls | Postgres RLS second wall | M4 (deferred, see response-01) |
| PR-01-J | moto fidelity unverified for bucket-policy denies (SSE-KMS required) → test evidence upload against real S3 in dev | M3 |
| ADR-028 | POST /dispute/{id}/evidence (declare more files later) | M2 |
| ADR-028 | evidence-intake Lambda (scan verdict, magic bytes, checksum, promote/delete) + service-port evidence result endpoint + EXPIRED sweep | M2 |
| ADR-028 | Verify: presigned PUT can sign x-amz-checksum-sha256; GuardDuty Malware Protection for S3 in af-south-1 + price; s3-request-presigner version | M0 follow-up (before P-01) |

---

## Rules for this file
- `owns` sets in one batch must be disjoint.
- Acceptance criteria are the test plan.
- Tasks found during review are appended here, not fixed inline.
- Accepted peer-review findings become tasks here, carrying the finding id.
