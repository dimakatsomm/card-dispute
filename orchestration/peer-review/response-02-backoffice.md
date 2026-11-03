# Response 02 — Back office (ADR-071, M5)

Reviewer: a fresh-context agent on a different model (Sonnet), **not** an independent second-model CLI (none is
installed here; the only CLI is `claude`). Weight accordingly. The brief can be pasted into another model for an
independent pass.

## Reviewer calibration
No canary (K1–K3) contradicted. The reviewer tagged its Cognito claims `[recall]` and did not read the frontend auth
code. The repo claims I spot-checked were right:
- `users`, `transactions` and `disputes` all build servers with `createGuardedServers`, so a global backstop change
  affects all three.
- Evidence writes do not bump `dispute.version` (`dispute-repo.ts:295`, "without touching version"). Adding evidence
  is allowed in UNDER_REVIEW (F-EVD-5).
- REVIEW and RESOLVE replays return `NO_OP` (`state-machine.ts:118`).

## Accepted — fixed now (in ADR-071 and the M5 criteria, this commit)
- **F1 shared `spa` client** → a dedicated `backoffice` Cognito app client (own callback `/agent/callback`). `token.ts`
  already classifies by client-id list; auth gains an agent client list, disjoint from user and service lists. An agent
  principal needs client ∈ agent list **and** `cognito:groups` ∋ `agents` **and** an ACTIVE `agent_identity` row. A
  customer-client token can never be an agent and an agent-client token never a customer. `ambiguous_role` stays as a
  backstop for a sub present in both identity tables.
- **F2 global backstop** → per-server option: `createGuardedServers({ publicGuards: ['user'] })` is the default; only
  disputes opts in to `['user', 'agent']`. The backstop also throws if an `/agent/*` route lacks the agent guard, or if
  an agent guard sits outside `/agent/*`. Tests in BO-03.
- **F3 evidence not in `version`** → review and resolution carry `expectedVersion` **and** `expectedEvidenceDigest`.
  The digest is returned by the agent detail: a hash of the dispute's evidence ids and statuses. It is recomputed under
  `SELECT … FOR UPDATE`, and a mismatch returns 412. `version` itself is not bumped by evidence, because the notifier's
  stale check (`isStaleEvent`) and the customer ETag rely on its current meaning.
- **Queue index** → a `(status, created_at)` index cannot order across two statuses. BO-01 adds a partial index
  `(created_at, id) where status in ('SUBMITTED','UNDER_REVIEW')`, and BO-01's `owns` gains
  `backend/disputes/migrations/**`.
- **`actor_id`** → it is `agentId` everywhere; `agent_identity` gains `display_name`, shown on the timeline as
  "Agent <display_name>". docs/05 corrected in BO-00.
- **Pick up has no owner** → the detail and queue show who picked the dispute up (from the REVIEW history row). A
  REVIEW replay stays a no-op 200 (domain table unchanged) and returns the current state, so the UI shows "already
  picked up by X". Any agent may resolve (team queue).
- **Resolve replay drops the note** → a replay with the same outcome returns 200 with the **stored** note unchanged;
  a BO-07 test asserts the first note stands.
- **Read audit** → BO-05 logs one structured `agent dispute viewed` line per detail read (agentId, disputeId, no
  customer data).
- **Stale email** → the notifier skips events older than the current version by design. BO-07 now asserts one email
  per *final* status, with intermediate ones allowed to be skipped, instead of "one per change".
- **Decomposition gaps** → the seeded agent subs are fixed in BO-00 (docs/02) so BO-01 and BO-04 agree; BO-00 owns
  docs/01, docs/04 and docs/06 too; BO-04 owns `local/README.md` and the mock-issuer side of the grant-parity exclusion
  list; BO-09 owns the Terraform side.
- **Offboarding order** → the BO-09 runbook says: disable the `agent_identity` row first (≤ 60 s), then remove the
  group and sign the user out globally.

## Accepted — logged
- **MFA for agents** (part of F1) → BO-09: agents are provisioned with TOTP required per user. Cognito access tokens
  do not prove MFA was used [recall], so the server cannot enforce it. Before real data: a separate pool with
  `mfa_configuration = "ON"` (owner question below).

## Partially accepted / rejected
- **Evidence viewing out of scope** → the owner ruled it out for this pass (2026-11-03). Accepted that agents deciding
  FRAUD or NOT_RECEIVED disputes without evidence is a demo limitation, so BO-09 is labelled **demo-only**. The scope is
  not reopened without the owner.
- **No IP allow-list** → rejected for dev: agents sign in from anywhere, mock data only, and the WAF is in front. It is
  listed with MFA as a before-real-data item.

## Open questions for the owner
1. Before real data: a separate Cognito pool for agents with MFA required, or the same pool with per-user TOTP
   enforced by provisioning?
2. Is it acceptable that agents decide without seeing evidence in the dev demo, or should evidence viewing (signed GET
   URLs, its own security review) be pulled into M5?
