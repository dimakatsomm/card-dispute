# 00 — Charter

## Problem
Cardholders need a self-service way to dispute a card transaction they don't recognise or
disagree with, see where the dispute stands, and be told when it changes.

## Scope
In:
- Customer views profile, accounts and masked cards (`GET /me`).
- Customer queries transactions by account, card, date range, status, amount (`GET /transactions`).
- Customer raises (`POST /dispute/{transactionId}`), edits, or withdraws (`PUT /dispute/{transactionId}`) a dispute, and attaches evidence files.
- Disputes are automatically queued for review and resolved by a human back-office agent via an internal API (no auto-accept, ADR-016).
- Customer sees dispute status and history (`GET /dispute/{transactionId}`).
- Dispute PII erased 1 year after closure (interim POPIA policy, ADR-017).
- Customer is emailed (SES) on every dispute status change.
- Mock accounts, cards and transactions seeded in Aurora.
- Deployed to AWS af-south-1, single `dev` environment, via Terraform and CI/CD.

Out (deferred, with reason):
- Back-office UI — the internal API is enough to prove resolution; UI is separate product work.
- Integration with a real card processor / scheme chargeback flow — mock data only.
- Multi-environment (dev/stage/prod), multi-region DR, load testing at production scale — out of scope for the first release.
- Customer sign-up UI — Cognito-hosted login is used; users are seeded.

## Success criteria
1. All requested endpoints behave as specified in `02-api.md`, including negative cases.
2. No customer can read or dispute another customer's data (e2e negative tests prove it).
3. A dispute moves SUBMITTED → UNDER_REVIEW via the event path and is resolved by an agent; each transition is audited and emailed.
4. The whole stack deploys from Terraform into af-south-1, and the e2e suite passes against it.

## Decisions log
See `orchestration/state.json` → `decisions`.
