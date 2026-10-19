# Peer Review Brief 01 — Architecture, data model, dispute rules, M1 decomposition

## Your role
You are an adversarial reviewer. **Do not be agreeable.** If a section is fine, write "no issue" and
move on. Spend your effort on what is wrong, missing, or will break in production.

Tag **every** claim you make: `[verified]` (you checked a primary source in this session),
`[recall]` (from memory), `[guess]`. "I don't know" is a correct answer — especially for AWS
regional availability, prices, package versions and API surfaces, where memory is often stale.

Read the real files, not this summary:
- `CLAUDE.md`
- `docs/01-architecture.md`, `docs/02-api.md`, `docs/03-data-model.md`, `docs/04-dispute-rules.md`, `docs/05-security.md`, `docs/06-infra.md`
- `orchestration/backlog.md`

Do not modify any file. Your output is an opinion, not an instruction set.

## Pre-verified canary facts (checked on primary sources 2026-10-09; flag only if you believe them wrong)
- K1: Amazon SES's SMTP interface is not available in af-south-1. The SES API is.
- K2: `nodejs24.x` is the latest GA AWS Lambda Node.js runtime. `nodejs26.x` is in preview.
- K3: PostgreSQL 18 has a native `uuidv7()` function, and Aurora PostgreSQL supports 18.x.

## Claims to attack (author confidence in brackets)

**A. Central `/validate` service** [medium]. Every request makes an extra network hop to auth, mitigated by a 60s cache in `auth-client`. Is a central validation service the wrong call compared with local JWKS verification in each service? What breaks when auth is down (we fail closed with 503)?

**B. `/validate` authenticates callers by network only** [LOW — weakest claim, attack this first]. See the note under "Route exposure" in `02-api.md`. It is the only s2s route without a service token. Is the justification sound? What can an attacker who gets code execution in one task do with it?

**C. `auth_identity.user_id` denormalisation (ADR-007)** [medium]. Auth stores a logical copy of users' `user_id` so `/validate` returns `userId` in one hop. Provisioning order, consistency, and who writes it are not fully specified. Is this a hidden coupling?

**D. Ownership via denormalised `user_id` on transactions** [medium-high]. Transactions trusts its own `user_id` column, seeded from users. Is there a way for a user to see another user's transactions, e.g. if a card moves accounts?

**E. Outbox + relay Lambda polling every minute** [medium]. Is the latency acceptable? Is `FOR UPDATE SKIP LOCKED` with a Lambda safe under concurrent invocations? Does ordering matter (Created before StatusChanged) given two independent standard queues?

**F. Dispute rules** [medium]. Check the eligibility order, the 120-day window measured from `posted_at`, the auto-accept threshold, and "never auto-reject". Do any states or transitions in the table contradict the diagram? Are concurrent USER WITHDRAW and SYSTEM RESOLVE handled?

**G. Idempotency design** [medium]. The key is scoped per user, stores the response, has a 24h TTL, and the same key with a different body returns 422. What happens if a request is still in flight when it is replayed?

**H. Data model** [medium]. Look for missing indexes, constraints and audit fields. Snapshot columns on dispute. Cross-schema logical references with no FK.

**I. POC infra** [medium]. One NAT, 2 AZs, Aurora at 0.5 ACU, about $205/month. Cognito token and JWKS calls go out through NAT. Is anything here a false economy?

**J. Local test stack** [low]. moto server replaces LocalStack (now licensed) for SQS and S3; SES is mocked at the SDK boundary. Is moto adequate for SQS DLQ redrive and S3 event notifications to SQS?

**K. M1 decomposition** [medium]. Check the `owns` sets for overlap within waves, missing tasks, and acceptance criteria that cannot be tested. Is P-01 (all of disputes POST+PUT in one task) too big?

## Required answer structure
1. **Fatal flaws** — anything that must change before code is written
2. **Per-claim verdict** — A through K: agree / disagree / partially, with reason and confidence tag
3. **What's missing** — requirements, failure modes, or security controls absent from the docs
4. **Where I'd overrule you** — decisions you would reverse, and why
5. **Your own uncertainty** — what you don't know and would need to check
