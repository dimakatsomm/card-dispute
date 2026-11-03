# Review 02 — Back office (ADR-071, M5)

Reviewer stance: adversarial. Tags: `[verified]` = read in the repo this session, `[recall]` = memory, `[guess]` = inference. I did not use the web, so every Cognito/AWS API claim is `[recall]` at best. I did not dispute the canary facts K1–K3; I confirmed K1 and K2 in the files `[verified]`. For K3, `lookupTransactions` takes `userId` plus a `transactionIds` list `[verified]`, so the agent detail lookup is feasible with the dispute's own `user_id`.

## 1. Fatal flaws (change before code is written)

**F1. Agent and customer principals share one client, one pool and one MFA setting, and the design builds a fragile rule to compensate (`ambiguous_role`). Bind principal type to the app client instead.**
- Today `classifyClaims` already says "the client decides the principal type" (`token.ts`), and `AUTH_USER_CLIENT_IDS` and `AUTH_SERVICE_CLIENT_IDS` are disjoint, branded and checked `[verified]`.
- Extend that pattern: add a third allow-list, `agent` client ids, backed by a separate Cognito app client (`agent-spa`). That client has its own callback URLs, a short access token (5 min is the Cognito minimum `[recall]`), a short refresh token, and no customer flows.
- Then: a token from the `agent` client plus the group plus an ACTIVE row yields an agent. A token from the `spa` client can never yield an agent, even if someone adds the group to a customer by mistake.
- `ambiguous_role` becomes unnecessary for the token path, or a defence-in-depth check only.
- Reusing `spa` is not a confused-deputy bug in the strict sense. The group claim is signed and Cognito users cannot self-assign groups when `allow_admin_create_user_only = true` `[verified]`. But it removes the one structural control the codebase already uses for service vs user, and it makes the single-pool blast radius worse (see F2).
- Confidence in the recommendation: `[verified]` for the code pattern, `[guess]` that the extra client is cheap in Terraform. It is one more `aws_cognito_user_pool_client`.

**F2. Before any real data: agents who can read and resolve every customer's disputes must have enforced MFA, and the design has no mechanism for that.**
- The pool is `mfa_configuration = "OPTIONAL"` with the comment that e2e uses AdminInitiateAuth without a challenge `[verified]`.
- Cognito MFA is a pool-level setting, so you cannot require it per group `[recall]`.
- Options: (a) a separate agent user pool with `ON` MFA; (b) a pre-token-generation trigger that withholds `cognito:groups`, or adds a claim, unless the sign-in used MFA. I do not know whether the access token reliably exposes the authentication method, so treat (b) as unproven `[guess]`.
- For dev with mock data, accepting this is fine, as long as ADR-071 states explicitly "agents on real data require pool-level or separate-pool MFA, tracked as a blocking item". Right now the ADR is silent. Add a backlog item that blocks any real-data rollout, not just a note.
- A separate pool (a) is the cleanest answer to F1 and F2 together. It costs a second issuer in the auth verifier config. That is more work, and I'd still take it over a group claim in the customer pool for production `[guess]`.

**F3. `GuardKind` backstop change is global to a shared package, so every service's public port silently becomes allowed to host agent routes.**
- `createGuardedServers` is used by all four services `[guess]` (it is in `auth-client`). BO-03 changes `guardAllRoutes(app, 'user')` to accept `user` or `agent` on the public port for everyone.
- After that, a developer who writes `registerAgentRoutes` in `users` or `transactions` passes the backstop with no test failing. Only disputes should ever host `/agent/*`.
- Fix: make the allowed public guard kinds an option of `createGuardedServers`, defaulting to `['user']`, with disputes passing `['user','agent']`. Add a test that `users` and `transactions` composition roots reject an agent guard.
- Also enforce path-kind agreement: a route under `/agent/*` must carry the agent guard, and a route guarded `agent` must live under `/agent/*`. Today the backstop checks only that some guard exists `[verified]` (`hasGuard`). A route registered through `registerPublicRoutes` at `/agent/x` gets the user guard and passes the backstop. It would be a dead-but-mismatched route, not a hole, because an agent token is refused by the user guard. The reverse case is a customer route registered with the agent guard by mistake, which makes it unusable for customers. Both are caught only by e2e, not by the backstop.

**F4. Version-checking does not cover evidence changes, so an agent can reject a dispute on stale evidence without a 412.**
- `lockForShareByTransaction` explicitly "keeps the status stable … without touching version or updated_at", and evidence inserts and settlements do not bump `dispute.version` `[verified]` (`dispute-repo.ts` around lines 273–297).
- F-EVD-5 lets customers add evidence while UNDER_REVIEW `[verified]` (`08-project-plan.md:107`).
- Sequence: agent opens detail at v2 with 1 file, the customer declares 2 more files, the agent resolves REJECTED with `expectedVersion: 2`. It succeeds. The customer's evidence arrived after the agent's view and is silently overridden by the decision.
- The same applies to evidence flipping PENDING → STORED/REJECTED between view and decision.
- Fix options: bump `version` on evidence add (but this changes ETag behaviour for customers, so review the customer flow), or send an `evidenceRevision` / evidence count in the detail and require it on resolve. The second option is more contained.
- Without a fix, "first commit wins" is true only for status and text changes.

## 2. Per-claim verdicts

**A. Agent identity = group AND active row — partly agree.**
- Requiring both is sound as a fail-closed switch `[guess]`. The row is the real kill switch, and the group is a second factor of intent.
- Cognito access tokens do carry `cognito:groups` `[recall]`, confidence fairly high but not verified. The mock issuer must match the real shape. If the real token shape differs, BO-04 passes locally and BO-09 fails in dev. Make BO-09's first step an assertion against a real dev access token, and do not assume the id-token claim format carries over.
- Removal asymmetry: disabling the row takes effect within the auth-client cache TTL, at most 60 s `[verified]` (`cacheMaxSeconds ?? 60`, min of exp and TTL). Removing the group takes effect only when the token expires (15 min) or a refresh happens, and a refresh token lives 1 day `[verified]`. A refreshed token re-evaluates groups `[recall]`. So group removal alone is a slow off-switch. The runbook must say "disable the row first".
- `ambiguous_role`: the rule is correct in intent but not enforceable across two independent stores at the data layer. Both tables are in the `auth` schema, so a trigger or a constraint could reject inserting a sub into one table when it exists in the other `[guess]`. Add that, so ambiguity is prevented at provisioning, not discovered at `/validate`.
- Failure mode to document: an operator adds a customer to `agents` by mistake. The spec says "group without row → `unknown_subject`", so the customer is locked out entirely until the group is removed. This is fail-closed and acceptable, but it is an outage for the customer. Consider falling through to the customer lookup when there is no agent row, so only an ACTIVE agent row elevates `[guess]`. The spec's own "row without group → customer lookup" is the mirror image, so be consistent either way.
- Contradiction: `docs/05-security.md:25` says `actor_id` = the agent's **sub**; BO-05 says `actor_id` = **agentId** (uuid from `agent_identity`) `[verified]`. Pick one. `agentId` is better (no Cognito sub in the audit trail), provided `agent_identity` rows are never deleted and carry a human-readable label. The table as specified has no name or email column, so an auditor cannot map `agentId` to a person without Cognito, and a deleted Cognito user loses that link `[verified]`. Add a `display_label` (an internal staff id, not PII).

**B. Agent routes on the public port, internet-reachable — partly agree for dev, disagree for production (see F1, F2).**
- Reaching agent routes via CloudFront → WAF → ALB is consistent with the existing path: the `/api/*` behaviour strips the prefix and the origin sets `x-cd-route: api` `[verified]` (`edge/main.tf`, `alb/main.tf`). I checked that SPA path `/agent/...` vs API `/agent/...` does not collide, because the header, not the path, separates them. Same pattern already holds for `/disputes` `[verified]`. No issue there.
- Acceptable for dev with mock data (ADR-059 already treats it so `[verified]`). For real data it is not, because of no MFA, no IP allow-list, no separate client, and the same hosted login as customers (credential-stuffing surface is shared).
- Add before any real data: WAF rule scoped to `/api/agent/*` with a stricter rate limit than customer routes (and ideally an IP allow-list, e.g. a corporate egress range) `[guess]`. Scope it by path, since path is the only thing WAF sees; the token is not inspected.
- No read audit. Agents can browse every customer's dispute; there is no record that agent X viewed dispute Y. Writes are audited via history, reads are not `[verified]` (no history row for reads; none specified in BO-05). At minimum log `agentId` + `disputeId` (not PII) on the detail route at info level. For a bank, a durable access log is expected `[guess]`.
- Browsing is unbounded: the queue is paged but there is no per-agent rate limit and the detail route takes any transactionId. That is intended access, but it makes exfiltration indistinguishable from work. Per-agent rate limiting is listed as H-01 in the plan `[verified]` for the queue only.

**C. Guard and backstop changes — partly agree.**
- See F3 for the shared-backstop problem.
- 403 for the wrong principal type is acceptable. Rule 4's "other users' resources return 404" is about resources of another user. An agent token on `/disputes/:id` is a route-class mismatch, not an ownership check, and the existing code returns 403 for user-vs-service already `[verified]` (`requireUser`, `requireService`). Keep 403 there. It does reveal that the route exists, but the routes are in the public OpenAPI anyway.
- A genuine rule-4 risk: agent detail uses `GET /agent/disputes/{transactionId}` and returns 404 only for unknown ids. That is intended (agents see everything), but the test must assert that a **customer** token on it is 403, never 404-or-200 by accident, and the central "customer routes reject agent tokens" test must iterate over all registered public routes rather than a hand-written list. Otherwise a future customer route registered with a hand-rolled guard escapes. Generate the route list from Fastify's route table `[guess]`.
- `userPrincipalOf` throws if the principal is not a user `[verified]`. A route that accepts either principal type does not exist; good. Make sure `agentPrincipalOf` mirrors it, and that no code path reads `request.principal` directly.

**D. Removing service-port ops and scopes — partly agree.**
Things that still depend on them `[verified]` by grep:
- `local/mock-issuer/src/config.ts:61` grants `svc-backoffice`; `local/README.md:83` documents it (README is owned by no task).
- `backend/disputes/test/helpers/fakes.ts:16` uses `scopes: ['disputes/review']` (BO-05 owns it, OK).
- `infra/terraform/modules/cognito/tests/cognito.tftest.hcl:98` asserts the scopes are absent from AWS (BO-09 owns the module, but this assertion becomes meaningless once the scopes are gone from the contract; delete or invert it).
- `orchestration/state.json:1092` records that the I-03t parity test excludes `svc-backoffice` through a deferred-clients list. That exclusion list must shrink in the same task that removes the client, or the parity test will pass vacuously or fail.
- Docs not in BO-00's `owns`: `docs/01-architecture.md`, `docs/04-dispute-rules.md:81` ("`GET :8081/review-queue`"), `docs/06-infra.md`, `docs/openapi/common.yaml:35-36` (inside `docs/openapi/**`, OK).
- Capability loss for F-BO: none that I can see. The `svc-backoffice` client also had `users/cards.read`; the new design replaces it by server-side lookup with the dispute's own `user_id` `[verified]`, which is fine.
- One real regression to check: F-BO-1 as written in the plan says "service port, scope `disputes/review`" `[verified]` (`08-project-plan.md:115`). The F-BO rows must be rewritten, otherwise the acceptance text and the contract disagree.

**E. Concurrency — partly agree.**
- Optimistic `expectedVersion` handles agent vs withdraw and agent vs edit correctly, because both bump `version` in the same conditional `update … where version = $2` `[verified]` (`dispute-repo.ts:338-339`).
- Gap 1: evidence does not bump version (F4).
- Gap 2: two agents. Agent A picks up (v1 → v2). Agent B, who loaded the queue earlier at v1, gets 412. Fine. But agent B who reloads (sees v2, UNDER_REVIEW) and calls REVIEW with `expectedVersion: 2` gets `NO_OP` success, because `replayIsNoOp: true` and `status === to` `[verified]` (`state-machine.ts`). B believes they own it. There is no assignee, so A and B can both work the same dispute and the later RESOLVE wins on version. If the product wants "pick up" to mean ownership, it needs an `assigned_agent` column, and then the REVIEW replay should be a no-op only for the same agent. If it does not, rename the action "start review" and say there is no ownership. As designed, "Pick up" is misleading.
- Gap 3: RESOLVE replay with the same outcome at the same version returns `NO_OP` success **and discards the second agent's note** (the transition table has no note) `[verified]` in table logic; whether the service overwrites the note on NO_OP is unspecified `[verified]` in BO-05. State it: on NO_OP the note is ignored, and the response must say so (e.g. return the stored note), or the agent believes their text was recorded.
- Gap 4: retention sweeper. It updates `description` and `resolution_note` without touching version or `updated_at` (trigger skips for `disputes_retention`) `[verified]` (`004_retention_erasure.sql`). An agent viewing a RESOLVED dispute may see `[erased]`. This is fine for the agent; the queue only holds SUBMITTED/UNDER_REVIEW, which the sweeper does not erase (`dispute_resolved_unerased_idx` is on resolved statuses) `[verified]`. No issue for the queue, but the detail view for a resolved dispute should handle the tombstone.
- Notifier: it skips stale events (`isStaleEvent`) `[verified]` (`delivery.ts`). An agent who picks up and resolves within the SQS delivery window will cause the "under review" email to be skipped as stale. BO-07 asserts "one email per status change"; this assertion is racy in e2e and also contradicts F-NTF-1 ("every status change emails") in production `[guess]` about how stale is defined. Either relax BO-07 to "one email per **delivered** event, and the latest status is always emailed", or confirm `isStaleEvent` only skips older-than-current versions of the **same** state. I did not read `isStaleEvent` itself. I only read its call site.

**F. Data exposure to agents — partly agree.**
- Queue without `userId` or contact data: good. The queue still exposes `transactionId` and `reasonCode`; fine.
- Over-exposed: free-text `description` and evidence `fileName` can contain PII or card numbers. Customers type "my card 4111…" into free text routinely `[guess]`. The no-PAN rule says PAN is never stored, but there is no input scrubbing on `description` `[guess]` (I didn't check). Agents will see whatever the customer typed. The rule-set claim "agents never see customer contact details" is true structurally but not for free text. State it as accepted risk.
- Also over-exposed: detail returns the transaction (merchant, amount, card last4) — needed for the decision, so fine.
- Missing for decisions: evidence viewing is out of scope by owner ruling `[verified]`, so an agent decides FRAUD or NOT_RECEIVED disputes without seeing the evidence the customer was required to upload. That is the single biggest functional gap and will drive a request for S3 access right after M5. The docs/05 threat model already mentions a "back-office read role (evidence)" `[verified]` (`05-security.md:16`), so the pressure is predictable. Say explicitly in the ADR that agents decide without evidence in M5 and decisions made this way are demo-only.
- Also missing: the agent cannot see the customer's previous disputes or the count (one-per-transaction anyway), nor the amount-at-risk ordering. Queue sorted oldest-first only; no SLA/age display. Minor.
- The `note` the agent writes is customer-visible and goes into an email. Check that the notifier escapes it (HTML/header injection) and that it is capped (2000 chars `[verified]` in BO-00). The email path is "SES via API" so header injection is moot, but HTML in a note rendered in a mail body is real `[guess]`. Add a security criterion.

**G. Decomposition — partly agree.**
- Waves: BO-02 depends on BO-01 (table) and BO-05 depends on BO-02 and BO-03; wave ordering is consistent `[verified]` against the backlog text. BO-06 listing "after BO-04's tokens" is right, but BO-06 also needs BO-00's generated types and BO-05's behaviour for anything beyond mocks; it's wave 2 while BO-05 is wave 3, so BO-06 can only be tested against mocks until wave 4. Acceptable if stated.
- `owns` overlaps and orphans:
  - BO-01 owns `local/seed/**` and BO-04 owns `local/mock-issuer/**`, in the same wave. The seeded agent sub must equal the mock-issuer sub. `SEED_USERS` in `config.ts` is shared by convention ("D-05 seed data reuses these exact subs") `[verified]`. Two parallel agents editing the same constant in two folders is exactly what the one-file-boundary rule is meant to prevent. Fix: BO-00 defines the agent subs (in the contract or a shared fixtures file) so both consume it.
  - "generated types regenerate" in BO-00: where do generated types live? BO-00 owns `docs/openapi/**`; the generated output location is not in any `owns` `[guess]`.
  - Unowned files that must change: `local/README.md`, `docs/01-architecture.md`, `docs/04-dispute-rules.md`, `docs/06-infra.md`, the parity test and its deferred-client list, `local/mock-issuer/test/app.test.ts` (mentions `svc-backoffice`, BO-04 owns it so OK).
  - BO-02 owns `backend/auth/src/**` but the verifier must extract `cognito:groups`; the `VerifiedClaims` type lives in `core/token.ts` inside that boundary, fine `[verified]`.
- Testability of criteria: mostly good (table-driven, e2e negatives). Prose-only or untestable as written:
  - "queue uses the `(status, created_at)` index with keyset cursor, oldest first, both statuses by default": an index on `(status, created_at)` cannot satisfy an ordered scan across **two** statuses; Postgres will sort or merge `[guess]`. At queue sizes in dev it is irrelevant, but the criterion cannot be asserted as stated. Either test with EXPLAIN on a seeded volume, or state "ordered by `(created_at, dispute_id)`" and drop the index claim. The keyset cursor also needs a tiebreaker (`dispute_id`), which the criterion omits.
  - "cache/single-flight behaviour unchanged" (BO-03): unverifiable unless an existing test is named.
  - "customers cannot reach agent routes": covered by e2e, good. "Agent cannot reach customer routes": covered by BO-07.
  - Missing criteria: no test that a disabled agent's cached principal expires within 60 s (BO-07 asserts "disabled agent → 401" but with a fresh token, so it never exercises the cache); no test for group-only or row-only tokens at e2e level.

## 3. What's missing

- A decision on MFA and a separate agent client or pool for real data (F1, F2), recorded as a blocking item for any real-data rollout.
- Agent read audit (who viewed which dispute), not only write history.
- Evidence-aware concurrency (F4).
- Ownership semantics for "pick up" (no assignee; second agent silently succeeds).
- Behaviour on NO_OP resolve: what happens to the second note.
- Agent offboarding runbook: disable row first, then remove group, then `AdminUserGlobalSignOut` `[recall]` for the refresh token; state the 60 s and 15 min windows.
- A provisioning path for `agent_identity`: the auth service role has SELECT only `[verified]` (BO-01), so rows are created by migrations/seed/dev-tools. Say who runs it and how it is reviewed, since this table is the privilege-escalation point.
- Segregation of duties: nothing stops an agent resolving a dispute of someone they know, or their own account if they hold a separate customer login with a different sub. `ambiguous_role` only catches the same sub. Out of scope for dev, but list it.
- The rollout-order hazard: other services' auth-client parse `/validate` with a closed schema `[guess]`. If auth is deployed with `principalType: agent` before the others are updated, agent tokens are rejected or turned into 503s there. It is safe-fail but check that `unavailable` is not what an unknown principal type maps to, or it will page.
- Updating F-BO-1..4 text and the endpoint table in `08-project-plan.md` §4.6 and §5 (they still say service port and `disputes/review` `[verified]`); BO-00 owns that file but the task text does not mention it.
- Customer-facing timeline hides agent identity (BY map) `[verified]` — good, and BO-05 must keep that: the new agent detail returns a different timeline that does include actor ids; do not reuse the customer timeline builder without checking which one leaks which fields.

## 4. Where I'd overrule you

1. Principal type should come from the **client id**, not just the group claim (F1). I'd overrule "same `spa` client".
2. The global change to the shared backstop (F3) should be a per-service option. I'd overrule "public-port backstop accepts `user` or `agent`" as a blanket rule.
3. "Pick up" should either assign or be renamed; I'd overrule the silent-success replay for a different agent.
4. `actor_id` = `agentId` (not sub) is right; I'd overrule docs/05 line 25 and add a label column.
5. For ADR-071's "evidence viewing is out": acceptable for a local milestone, but not for a dev rollout described as production patterns, since decisions are made blind. At minimum label BO-09 "demo only".
6. `ambiguous_role` should be prevented at provisioning (cross-table trigger) rather than only detected at validate time.

## 5. Your own uncertainty

- Everything about Cognito behaviour is `[recall]` only: that access tokens contain `cognito:groups`; that group changes apply only at the next token issue or refresh; that MFA is pool-level; that 5 minutes is the minimum access-token lifetime; that `AdminUserGlobalSignOut` revokes refresh tokens only. I did not verify any of these against current AWS docs.
- I did not read `isStaleEvent` or the notifier tests, so my email-skip concern (section 2E) is a call-site inference `[guess]`.
- I did not confirm that `createGuardedServers` is used by all four services (F3) `[guess]`; I only read the package.
- I did not read the frontend auth code, so I cannot say whether the SPA reads `cognito:groups` from the id token in a way that matches what the real pool emits, nor whether the SPA calls `/me` on login (which would 403 for agents and break the agent landing).
- I did not check whether `description` input is scrubbed for card numbers.
- I did not run any tests or typechecks; all "[verified]" tags mean "read in the file", not "executed".
