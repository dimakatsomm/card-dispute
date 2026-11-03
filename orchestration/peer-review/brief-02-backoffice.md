# Peer Review Brief 02 — Back office (ADR-071, M5)

## Your role
You are an adversarial reviewer. **Do not be agreeable.** If a section is fine, write "no issue" and
move on. Spend your effort on what is wrong, missing, or will break in production.

Tag **every** claim you make: `[verified]` (you checked a primary source or the repo in this session),
`[recall]` (from memory), `[guess]`. "I don't know" is a correct answer, especially for Cognito token
claims, AWS API surfaces, package names and prices, where memory is often stale.

Read the real files, not this summary:
- `CLAUDE.md` (rules 4 and 5, domain guardrails)
- `docs/06-infra.md` row **ADR-071** (and ADR-026, ADR-039, ADR-064 it amends)
- `orchestration/backlog.md`, section **"M5 — Back office"**
- `docs/05-security.md`, `docs/04-dispute-rules.md`, `docs/08-project-plan.md` §4.6 (F-BO-1..6)
- `docs/openapi/auth.service.yaml`, `docs/openapi/disputes.public.yaml`, `docs/openapi/disputes.service.yaml`
- `backend/auth/src/core/token.ts`, `backend/auth/src/use-cases/validate-token.ts`
- `backend/packages/auth-client/src/guards.ts`, `backend/packages/auth-client/src/routes.ts`
- `backend/packages/dispute-domain/src/state-machine.ts`
- `backend/disputes/migrations/001_dispute.sql`, `002_dispute_status_history.sql`
- `infra/terraform/modules/alb/main.tf`, `infra/terraform/modules/cognito/main.tf`

Do not modify any file. Your output is an opinion, not an instruction set.

## Pre-verified canary facts (checked in the repo 2026-11-03; flag only if you believe them wrong)
- K1: The transition table already has `REVIEW` with actor `AGENT`, from `[SUBMITTED]` to `UNDER_REVIEW`, `replayIsNoOp: true` (`state-machine.ts:64`).
- K2: `dispute_status_history.actor_type` allows `AGENT`, and `dispute.created_by/updated_by` accept the `AGENT:` prefix (migrations 001/002).
- K3: transactions' service route `GET /transactions` requires `userId` and returns only rows owned by that user (`transactions.service.yaml`).

## Claims to attack (author confidence in brackets)

**A. Agent identity = `cognito:groups` ∋ `agents` AND an ACTIVE `auth.agent_identity` row** [medium].
Is requiring both sound? Does a Cognito **access** token carry `cognito:groups` (author: [recall], fairly sure)? What happens on group removal vs row disable, given the 60 s auth-client cache and 15 min access tokens? Is `ambiguous_role` (sub is both agent and customer) the right rule, and is it enforceable when both stores change independently?

**B. Agent routes on the disputes PUBLIC port under `/agent/*`, reachable from the internet via CloudFront → WAF → ALB** [LOW — weakest claim, attack this first].
An agent account can read and resolve **every customer's** disputes. The design adds no MFA requirement (the pool has `mfa_configuration = "OPTIONAL"`), no IP allow-list, no separate client or session lifetime, and reuses the customer `spa` client and hosted login. Is that acceptable for dev with mock data, and what must change before real data? Is reusing the `spa` client a confused-deputy risk (a customer token and an agent token look the same apart from the group claim)?

**C. Guard and backstop changes in auth-client** [medium]. `GuardKind` gains `agent`; the public-port backstop accepts `user` or `agent` guards. Can a route end up guarded for the wrong principal without a test failing? Is "customer guards refuse agent tokens" (403) enough, given rule 4 ("other users' resources return 404")?

**D. Removing the service-port back-office ops and the `disputes/review|resolve` scopes** [medium-high]. Does anything (seed, mock issuer grants, parity test, notifier, docs) still depend on them? Does removal lose any capability that F-BO needs?

**E. Concurrency: review/resolve vs customer withdraw and edit** [medium]. All writes carry `expectedVersion`; first commit wins; 412 stale, 409 invalid transition. Is optimistic versioning sufficient, or is there a window (e.g. evidence-intake writes, retention sweeper) that bumps or does not bump `version` and breaks agents' expectations? Two agents picking up the same dispute?

**F. Data exposure to agents** [medium]. The queue returns no `userId` or contact data; the detail returns description, timeline, evidence metadata and the transaction (looked up server-side with the dispute's own `user_id`). Is anything still over-exposed (free-text description, file names)? Is anything missing that an agent needs to decide, pushing them to ask for more access later?

**G. Decomposition** [medium]. Are the `owns` sets disjoint and the waves ordered correctly (BO-02 depends on BO-01's table; BO-06 on BO-04's tokens)? Are acceptance criteria testable, and is any criterion only asserted in prose?

## Answer structure (fixed)
1. Fatal flaws (change before code is written)
2. Per-claim verdict (A–G): agree / disagree / partly, with tags
3. What's missing
4. Where I'd overrule you
5. Your own uncertainty
