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
  - evaluateTransactionEligibility(txn, card, existingDispute, now) returns Result<true, EligibilityReason> with the first failing code in docs/04 order: ALREADY_DISPUTED (any status incl. WITHDRAWN), CARD_EXPIRED, TXN_NOT_POSTED, TXN_TYPE_NOT_DISPUTABLE, OUTSIDE_WINDOW [ADR-020/021]
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
owns: [docker-compose.yml, local/mock-issuer/**, local/moto/**, local/.env.example, local/README.md]
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
  - explicit UPDATE grants to the _app role only where needed: auth_identity (status) (D-00 defaults are SELECT + INSERT)
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
  - explicit UPDATE grants to the _app role only where needed: app_user, account, card (non-key columns) (D-00 defaults are SELECT + INSERT)
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
  - explicit UPDATE grants to the _app role only where needed: none — transactions are written only by seed (migrator) in dev; no UPDATE grant (D-00 defaults are SELECT + INSERT)
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
  - D-00 defaults give disputes_app SELECT + INSERT only → grant `UPDATE` explicitly on dispute (status/version/resolution/description/reason/updated_* columns) and dispute_evidence (status, s3_key, rejection_reason, stored_at); NO update grant on dispute_status_history; `GRANT UPDATE (note, before, after) ON dispute_status_history TO disputes_retention` + evidence/dispute retention columns per docs/03; tests prove history UPDATE → 42501 for disputes_app and retention cannot touch other columns
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
  - auth cannot use auth-client (it would call itself): build servers with @cd/shared createServers; /validate is the only service-port route and verifies the CALLER token locally (JWKS, scope auth/validate) before anything else; a test proves an unauthenticated /validate call is 401 [S-04 note]
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm install --frozen-lockfile --prod --filter @cd/<svc>...`; NOT `pnpm deploy` — Node cannot strip types under node_modules, ADR-052), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint for the migration task; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
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
  - servers built with `createGuardedServers` from @cd/auth-client (registration backstop: an unguarded route fails at startup); routes registered only via registerPublicRoutes/registerServiceRoutes [S-04]
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm install --frozen-lockfile --prod --filter @cd/<svc>...`; NOT `pnpm deploy` — Node cannot strip types under node_modules, ADR-052), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint for the migration task; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
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
  - servers built with `createGuardedServers` from @cd/auth-client (registration backstop: an unguarded route fails at startup); routes registered only via registerPublicRoutes/registerServiceRoutes [S-04]
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm install --frozen-lockfile --prod --filter @cd/<svc>...`; NOT `pnpm deploy` — Node cannot strip types under node_modules, ADR-052), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint for the migration task; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
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
  - servers built with `createGuardedServers` from @cd/auth-client (registration backstop: an unguarded route fails at startup); routes registered only via registerPublicRoutes/registerServiceRoutes [S-04]
  - Dockerfile: multi-stage, ARM64, non-root, pruned prod deps (`pnpm install --frozen-lockfile --prod --filter @cd/<svc>...`; NOT `pnpm deploy` — Node cannot strip types under node_modules, ADR-052), exposes 8080 + 8081, HEALTHCHECK on /health; `migrate` entrypoint; Trivy scan has no fixable HIGH/CRITICAL [ADR-030]
  - POST fetches txn via transactions GET :8081/transactions?userId=<principal>&transactionIds=<id> (service token) and card via users GET /cards (service token); not found/not owned → 404 [ADR-020: card expiry blocks]
  - eligibility decided only by evaluateTransactionEligibility + validateDisputeInput from @cd/dispute-domain with now = DB now() from the same transaction (no rule literals in service code — grep test for "120")
  - one DB transaction writes dispute + history; a forced failure after the dispute insert leaves no rows
  - after commit, publishes DisputeCreated to the notifications queue via an injected publisher; publish failure is logged + metric and does NOT change the 201 (test with a failing stub)
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

## M2 — Evidence pipeline, notifications, retention (decomposed 2026-10-20)

**Outcome:** an uploaded file is scanned and shows as added or rejected on the timeline; the customer is emailed at every step; unused upload slots expire and closed disputes' PII (incl. evidence file names) is erased after a year (clock injection); poison messages land in DLQs.

Scope rulings: back office deferred (ADR-039); no automation changes dispute status (ADR-016); one notifications queue (ADR-054); M2 rulings ADR-055; boundary schemas generated from docs/openapi (ADR-056/057, S-08 done), so every new route and Lambda parses with `@cd/contracts`. P-06 dropped (publish-after-commit and EventPublishFailed already shipped in P-01/P-02).

Waves: 0 M2-00 → 1 S-06, S-07, D-06, W-06, L-06 → 2 P-05a, L-03, L-04, L-05 → 3 P-05b, then L-07 → 4 E-02a, E-02b → milestone-close. Critical path S-06 → P-05a → P-05b → E-02. 🔒 = security-reviewer mandatory.

### M2-00 · Contract, catalog and scaffold prep
```yaml
agent: implementer
owns: [docs/**, orchestration/**, pnpm-workspace.yaml, pnpm-lock.yaml, package.json, backend/packages/contracts/src/**, frontend/src/api/generated/**, backend/lambdas/*/package.json, local/lambda-driver/package.json]
depends_on: [S-08]
acceptance:
  - quarantine key intake/{transactionId}/{evidenceId} (ADR-055) in docs/01, docs/02, docs/03 and the specs
  - service PUT evidence result returns 200 {evidenceId, status, s3Key?}; s3Key = evidence/{disputeId}/{evidenceId}, set by disputes only; STORED facts that differ from the declared ones are recorded REJECTED (TYPE_MISMATCH/SIZE/CHECKSUM) and answered 200 status REJECTED; 404 for an evidenceId that is not this dispute's; 409 for EXPIRED/ERASED or a conflicting settled result
  - service GET /disputes items add version; svc-notifier scopes users/contact.read + disputes/read (docs/05); intake is EventBridge to Lambda with an async DLQ (docs/01)
  - event payloads (docs/03): EvidenceUploaded becomes EvidenceStored | EvidenceRejected, data.evidence {evidenceId, reason?}, no file name
  - retention (docs/03): WITHDRAWN terminal time = WITHDRAW history row; erasure does not bump updated_at; erasure also sets evidence file_name to '[erased]'
  - pnpm lint:api, pnpm gen:contracts and frontend gen/check:api clean
  - catalog gains @aws-sdk/client-secrets-manager (a version at least 2 weeks old, checked on npm); skeleton package.json (catalog deps only) for @cd/evidence-intake, @cd/dispute-notifier, @cd/retention-sweeper and @cd/lambda-driver; one pnpm install
  - verify on the compose moto: SQS RedrivePolicy moves to the DLQ after maxReceiveCount; PutObjectTagging; presigned PUT checksum enforcement (V-08 stays open for E-03); Lambda RIE behaviour in public.ecr.aws/lambda/nodejs:24; record results under orchestration/
  - docs/08 M2 table updated (P-06 folded, new ids); R-11 points at P-05b, V-10 at E-02a
```

### S-06 · dispute-domain: event schema, evidence rules, retention policy 🔒
```yaml
agent: dispute-domain
owns: [backend/packages/dispute-domain/**]
depends_on: [M2-00]
acceptance:
  - parseDisputeEvent (zod strict, discriminated on eventType) returns a Result; types DisputeCreated, DisputeEdited, DisputeStatusChanged, EvidenceStored, EvidenceRejected; uuid ids, ISO occurredAt, integer version >= 1. Negatives: unknown eventType, missing version, non-uuid id, any extra key (email/to/name) all fail, so events cannot carry PII
  - isStaleEvent(event, currentVersion) is true only for Created/Edited/StatusChanged with version < current; evidence events are never stale (table)
  - single sources exported: evidence content types, MAX_EVIDENCE_BYTES, MAX_EVIDENCE_PER_DISPUTE=5, rejection reasons MALWARE/TYPE_MISMATCH/CHECKSUM/SIZE/SCAN_FAILED, upload TTL, ERASED_TEXT='[erased]'; the contracts enum drift test covers them
  - detectEvidenceType(head: Uint8Array) detects PDF/JPEG/PNG by magic bytes; an MZ head, a truncated head and '%PDF-' not at offset 0 return null
  - slotExpiryCutoff(now) is 24 h; erasureCutoff(now) is 1 UTC calendar year; boundary table: exactly at the cutoff eligible, 1 ms before not, Feb-29 terminal date covered
  - pure: no Date.now, no node built-ins
```

### S-07 · Lambda kit in shared + auth-client without fastify 🔒
```yaml
agent: implementer
owns: [backend/packages/shared/**, backend/packages/auth-client/**]
depends_on: [M2-00]
acceptance:
  - @cd/shared/lambda re-exports loadConfig, createLogger and the correlation helpers, and adds emitMetric (EMF, same shape as EventPublishFailed) and createSecretResolver(client) returning a Result (no throw on a missing secret)
  - auth-client http-client stops importing the @cd/shared root; @cd/auth-client/service-client exports the token provider and HTTP client only (S-05 compare-and-clear retry kept)
  - a test bundles each subpath with esbuild; the metafile has no fastify or server.ts
  - existing exports and tests unchanged and green
```

### D-06 · disputes migration 004: retention erasure 🔒
```yaml
agent: data-schema
owns: [backend/disputes/migrations/004_*.sql, backend/disputes/migrations/test/**]
depends_on: [M2-00]
acceptance:
  - disputes_retention updating description/resolution_note leaves dispute.updated_at unchanged; disputes_app updates still bump it (both tested)
  - disputes_retention gains UPDATE (file_name) on dispute_evidence (ADR-055); the ERASED guard allows file_name='[erased]' only together with status ERASED; no other new grants (tested)
  - history guard and evidence ERASED guard stay enabled; existing tests green
  - plan test: the sweeper's candidate queries (PENDING evidence by age; terminal disputes by age) use an index; add a partial index only if the plan shows a seq scan
```

### W-06 · web: evidence status updates and edge polish
```yaml
agent: frontend
owns: [frontend/src/screens/dispute-detail/**, frontend/src/screens/disputes/labels.ts, frontend/src/screens/disputes/labels.test.ts, frontend/src/components/evidence/**, frontend/test/evidence/**]
depends_on: []
acceptance:
  - the detail screen polls only while some evidence is PENDING and the tab is visible; it stops when none is PENDING or after a capped window ("still checking, refresh"); fake-timer test: PENDING to STORED shows "Evidence added" without reload
  - zero extra requests when nothing is PENDING; stops on unmount; a refetch keeps an open edit draft or withdraw dialog; edit uses the refreshed ETag
  - REJECTED shows a message per reason (MALWARE, TYPE_MISMATCH, CHECKSUM, SIZE); EXPIRED shows a hint linking add-evidence while the dispute is open; ERASED renders neutrally
  - resolution note shown for RESOLVED_*, absent when null; an erased dispute ('[erased]' description, null note, erased file names) shows "removed under our retention policy"
  - status changes announced in an aria-live=polite region; check:api clean
```

### L-06 · local Lambda driver: scan stub, SQS poller, SES sink
```yaml
agent: implementer
owns: [local/lambda-driver/**]
depends_on: [M2-00]
acceptance:
  - scan stub: a quarantine object without the GuardDutyMalwareScanStatus tag gets THREATS_FOUND for EICAR and NO_THREATS_FOUND otherwise; it sets the tag, then POSTs a GuardDuty-shaped EventBridge event to the intake RIE
  - intake failure mimics Lambda async: 2 retries, then the original event goes to queue evidence-intake-dlq (README: emulation; the real proof is E-03)
  - SQS poller mimics an event-source mapping: long-poll batches of up to 10, invoke the RIE, delete only records not in batchItemFailures; moto RedrivePolicy moves repeats to the DLQ
  - SES sink: SESv2 POST /v2/email/outbound-emails, GET and DELETE /sent; with SES_VERIFIED set, an unverified recipient gets a MessageRejected-style 400
  - CLI invoke <function> [json]; the retention sweeper runs by CLI as a stand-in for the EventBridge schedule
  - tests (moto + a fake RIE): partial failure deletes only the good records; EICAR gives THREATS_FOUND and a tag; three intake failures give a DLQ message with the original event; sandbox rejection
  - moto stores no SHA-256 checksum on PUT (verify-m2-00.md): before posting the event, the scan stub self-copies the object with ChecksumAlgorithm SHA256 so HeadObject returns one; README states local checksums cannot detect tampering
  - RIE returns 200 even on handler error or timeout: detect failure from the body (errorType JSON or the non-JSON timeout text), not the status; emulate async retries fully
  - not referenced by any deployable Dockerfile
```

### P-05a · POST /dispute/{transactionId}/evidence 🔒
```yaml
agent: service-api
owns: [backend/disputes/src/**, backend/disputes/test/**, backend/disputes/package.json]
depends_on: [S-06, M2-00]
acceptance:
  - public port, user principal; body parsed with the generated schema (declaration schema shared with create)
  - another user's or an unknown transaction gives 404 and no rows; a terminal dispute gives 409 INVALID_TRANSITION; SUBMITTED and UNDER_REVIEW allowed (use the seeded UNDER_REVIEW dispute)
  - cap: dispute row FOR UPDATE; PENDING+STORED+new > 5 gives 413 TOO_MANY_FILES and inserts nothing; EXPIRED/REJECTED/ERASED don't count (table); two concurrent 3-file requests on an empty dispute give one 201 and one 413
  - ADR-050: a declaration equal (sha256+size+type) to a PENDING item gets 201 with the same evidenceId, no new row and a fresh URL; matches against STORED/REJECTED/EXPIRED get a new slot; each row matched at most once per request; a different fileName does not create a slot
  - signer uses quarantine key intake/{transactionId}/{evidenceId}; create path and moto helper updated; a signed PUT works on moto
  - signing failure gives 503 UPLOAD_SIGNING_UNAVAILABLE with rows committed; a repeat re-signs the same slots (ADR-054)
  - writes no history row, no version or updated_at change, no event
  - evidence types, caps and TTL come from @cd/dispute-domain (grep: no 'application/pdf' or 10485760 literal in src)
```

### P-05b · PUT …/evidence/{evidenceId} (scan result), evidence events, version in lookup 🔒
```yaml
agent: service-api
owns: [backend/disputes/src/**, backend/disputes/test/**]
depends_on: [P-05a]
acceptance:
  - service port only (8080 gives 404); a user token gives 403; disputes/read instead of disputes/evidence.write gives 403; no token gives 401 (one test each)
  - generated body (reason required iff REJECTED); an unknown or other dispute's evidenceId gives 404
  - STORED with differing facts is recorded REJECTED (TYPE_MISMATCH, SIZE or CHECKSUM, one test each) and answered 200 status REJECTED; s3Key is derived by disputes and never read from the body
  - R-11: one transaction does UPDATE … WHERE status='PENDING' plus a history EVIDENCE_ADDED/EVIDENCE_REJECTED row (from=to=current status, actor SYSTEM_RULE:evidence-intake, after={evidenceId}); GET /dispute/{id} shows EVIDENCE_ADDED with fileName and EVIDENCE_REJECTED with reason
  - an idempotent repeat gives 200 with no second history row or event; STORED then REJECTED (or the reverse) gives 409; EXPIRED/ERASED gives 409; two concurrent identical PUTs give one history row; a race with the sweeper's PENDING to EXPIRED leaves no half state (two connections)
  - dispute.version and updated_at unchanged (a customer's If-Match still works)
  - after commit publishes EvidenceStored/EvidenceRejected with the current version and no file name; a publish failure still gives 200; a no-op repeat publishes nothing
  - service GET /disputes items include version; transactions' tests stay green
  - the local DisputeEvent type is replaced by the @cd/dispute-domain schema; created and edited events validate against it
```

### L-03 · evidence-intake Lambda 🔒
```yaml
agent: async-lambda
owns: [backend/lambdas/evidence-intake/**]
depends_on: [S-06, S-07, M2-00]
acceptance:
  - esbuild bundle in a Dockerfile FROM public.ecr.aws/lambda/nodejs:24; docs/10 layout; calls disputes via @cd/contracts/disputes.service
  - the event is zod-parsed; bucket must equal QUARANTINE_BUCKET and the key must match intake/{uuid}/{uuid}; otherwise it throws (ends in the DLQ) and calls nothing
  - the verdict comes from the event, never the bytes: NO_THREATS_FOUND continues; THREATS_FOUND gives REJECTED MALWARE; UNSUPPORTED, ACCESS_DENIED, FAILED and scanStatus SKIPPED/FAILED give REJECTED SCAN_FAILED (facts optional)
  - facts from HeadObject (ContentLength, ChecksumSHA256 as hex, ContentType) plus a ranged GET through detectEvidenceType; a renamed exe declared as PDF is TYPE_MISMATCH and never copied; oversize is SIZE; a missing checksum is CHECKSUM
  - order: PUT the result (svc token disputes/evidence.write, correlation id), then act on the response. STORED: CopyObject to the evidence bucket at the response s3Key, then DeleteObject from quarantine. REJECTED: delete only. disputes answering REJECTED to a claimed STORED copies nothing
  - retries: copy done but delete failed, retried, completes; a duplicate after the object is gone (HeadObject 404) is a success no-op; disputes 5xx or timeout throws; 409 EXPIRED deletes and succeeds; 404 throws and keeps the object
  - V-03 fallback EVIDENCE_REQUIRE_SCAN=false accepts the S3 Object Created event, skips the verdict and emits EvidenceNotScanned (metric + warn); default true rejects Object Created (the flag cannot be bypassed by event shape)
  - logs contain no file names or PII; integration test on moto + an HTTP stub of disputes; the moto test self-copies uploads with ChecksumAlgorithm SHA256 first (moto stores none on PUT); never apply the tag-based bucket policy on moto (it denies everything)
  - REJECTED results for ACCESS_DENIED/FAILED/SKIPPED or a failed HeadObject omit the facts (optional on REJECTED per M2-00b)
```

### L-04 · dispute-notifier Lambda 🔒
```yaml
agent: async-lambda
owns: [backend/lambdas/dispute-notifier/**]
depends_on: [S-06, S-07, M2-00]
acceptance:
  - SQS envelope zod-parsed; record body goes through parseDisputeEvent; garbage, a bad schema or an extra email/to key gives a batchItemFailure and no email
  - the recipient comes only from users/{event.userId}/contact (svc-notifier, @cd/contracts/users.service); contact 404 or 5xx gives a failure and no email; SES To equals the contact email
  - staleness via the GET :8081/disputes version (disputes/read): a stale Created/Edited/StatusChanged is skipped (success); evidence events never skipped; a lookup failure gives a failure (no send-on-doubt); a dispute absent for that user gives a failure
  - pure templates: subject and body per event type and status with the status text, date, a dispute reference and first name; the name is HTML-escaped (<script> test); rejection reason in plain words; no file name
  - SESv2 SendEmailCommand; sender from config (SES_SENDER); SES_ENDPOINT override; MessageRejected or throttling gives a failure
  - a batch of ok/poison/ok gives exactly the poison's messageId in batchItemFailures; a duplicate delivery sends again (accepted)
  - with moto, a poison record received 5 times lands in dispute-notifications-dlq
  - log PII redaction test; SES mocked at the SDK boundary
```

### L-05 · retention-sweeper Lambda 🔒
```yaml
agent: async-lambda
owns: [backend/lambdas/retention-sweeper/**]
depends_on: [S-06, S-07, D-06, M2-00]
acceptance:
  - connects as disputes_retention (DATABASE_URL locally, secret in AWS, SSL flag); fails fast if current_user differs; disputes.-qualified names; the schedule event content is ignored ({now:"2099-…"} changes nothing; the clock is injected)
  - slot expiry: PENDING evidence at or beyond 24 h goes to EXPIRED (status only); younger PENDING and STORED rows untouched; a second run changes 0
  - candidates: RESOLVED_* by resolved_at, WITHDRAWN by the WITHDRAW history row; SUBMITTED and UNDER_REVIEW never erased (negative)
  - clock proof (testcontainers, real migrations): a dispute terminal at T is untouched at T+1y−1ms and erased at T+1y
  - erase effect: description '[erased]'; resolution_note null; history note/before/after null with rows kept; evidence ERASED with s3_key and rejection_reason null and file_name '[erased]'; status, version, user_id, transaction_id and reason_code intact; updated_at unchanged
  - one transaction per dispute (a forced failure leaves it wholly unerased); a second run changes 0; batch cap env (cap+1 eligible gives cap, then 1 on the next run)
  - EMF counts EvidenceExpired and RetentionErased; logs disputeId only; does not touch S3 (365-day lifecycle; README says so)
```

### L-07 · local compose wiring for the Lambdas
```yaml
agent: implementer
owns: [docker-compose.lambdas.yml, local/moto/init.py, local/.env.example, local/README.md, local/mock-issuer/src/config.ts, local/mock-issuer/test/**]
depends_on: [L-03, L-04, L-05, L-06]
acceptance:
  - the override builds the three Lambda images and runs lambda-driver; RIE ports bound to 127.0.0.1 only; no 8081 published; env uses svc-evidence-intake, svc-notifier and the disputes_retention URL
  - moto-init adds evidence-intake-dlq and a short local visibility timeout on the notifications queue (MaxReceive stays 5)
  - mock-issuer grants svc-notifier disputes/read; README updated; its tests green
  - compose config valid; up --build --wait brings everything healthy; the M1 e2e and Playwright smoke still pass (evidence now reaches STORED)
  - the orchestrator then adds -f docker-compose.lambdas.yml to compose:local and a local:invoke script
```

### E-02a · async-flow e2e plus V-10 🔒 (gate by test-engineer)
```yaml
agent: test-engineer
owns: [tests/e2e/**]
depends_on: [P-05b, L-07]
acceptance:
  - clean PDF via the presigned PUT: within a bounded wait the detail shows STORED and the timeline EVIDENCE_ADDED with fileName; the object is at evidence/{disputeId}/{evidenceId} and gone from quarantine
  - EICAR gives EVIDENCE_REJECTED MALWARE with nothing promoted; a renamed exe declared as PDF gives TYPE_MISMATCH; re-POST of the same declaration returns the same evidenceId
  - ses-sink holds mail for submitted, edit, evidence added, evidence rejected and withdrawn; every recipient is A's address
  - retention via the RIE with rows backdated by the admin URL: a 2-day PENDING slot becomes EXPIRED; RESOLVED 366 d is erased (incl. file names); RESOLVED 364 d and an old SUBMITTED stay untouched
  - DLQs: garbage and a well-formed event with an unknown userId end in dispute-notifications-dlq; garbage to the intake RIE ends in evidence-intake-dlq
  - V-10 inside the compose network: a user token on disputes:8081 and on the users:8081 contact route gives 403; no token gives 401; svc-notifier on PUT evidence gives 403; svc-evidence-intake on contact gives 403; svc-notifier contact gives 200 for A and 404 for an unknown uuid
  - no per-endpoint auth repetition (ADR-040); pnpm test:e2e output attached
```

### E-02b · Playwright for evidence status
```yaml
agent: test-engineer
owns: [tests/ui/**]
depends_on: [W-06, L-07, P-05b]
acceptance:
  - a clean PDF shows Scanning, then Stored with "Evidence added" on the timeline, without reload; an EICAR file shows Rejected with the malware message
  - a seeded RESOLVED dispute shows its resolution note; the add-evidence screen adds a file to an open dispute
  - the existing M1 smoke still passes
```

### M2 risks
- moto fidelity (redrive, tagging, presigned checksum, bucket-policy denies) is checked in M2-00; the real proof is E-03 (V-08 open).
- The local intake DLQ and async retries are emulated by the driver; AWS behaviour is proven in M3.
- Record-then-copy order: a persistently failing copy leaves a STORED row with no object after the 1-day quarantine lifecycle; mitigated by the DLQ alarm in M3 (I-09/I-13).
- The production bucket policy denies GetObject without NO_THREATS_FOUND, which also blocks the unscanned fallback; an M3 Terraform concern.
- SES sandbox: only verified recipients get mail; the sink emulates it locally; real delivery is verified in E-03; DMARC for icloud.com is open (R-6).
- Evidence now reaches STORED in the M1 e2e and UI tests; L-07 and E-02 re-run them.
- Evidence promoted late in an open dispute could hit the 365-day lifecycle early; accepted edge.

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
