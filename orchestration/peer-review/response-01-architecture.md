# Response to Peer Review 01 — Architecture

Reviewer: Claude Sonnet (Agent, separate context), 2026-10-09. Review: `review-01-architecture.md`.

## Reviewer calibration
**Good.** It left all three canaries (K1 SES SMTP, K2 nodejs24.x, K3 PG18 uuidv7) undisputed. It tagged
most claims honestly as reading/recall and verified two claims on primary sources: Service Connect
mechanics and the PostgreSQL reserved word `user`. Both verified claims exposed real defects.
Findings are weighted accordingly: high weight, but its `[guess]` cost figures are not taken as fact.

## Accepted — fixed now (docs updated)
| Finding | Fix | Where |
|---|---|---|
| F1 double refund via re-dispute after RESOLVED_ACCEPTED; rule vs Q-07 contradiction | Rule 8 `ALREADY_RESOLVED` + second partial unique index; Q-07 closed | 04 rules, 03 model, backlog S-02/D-04/P-01 |
| F2 auto-decision on stale payload; WITHDRAW vs RESOLVE race | Auto-decide runs in disputes on the locked current row; `expectedVersion` on internal calls; DisputeEdited re-triggers; DB clock | 04 Concurrency, 02 internal, 01 |
| F3 Lambdas cannot use Service Connect | Internal ALB for Lambda → `/internal/*`; cost line added (unit price still unverified) | 01, 02, 06 |
| F4 `/validate` specified two ways; wrong justification; transactions over-scoped | `/validate` requires caller service token (scope `auth/validate`), no exception to rule 5; transactions loses `users/cards.read` | 02, 05, backlog A-01 |
| F5 DUPLICATE rule has no data source | `GET /internal/transactions` (scope `transactions/read`) | 02, 04 |
| F6 `user` reserved word | Table renamed `app_user` | 03, backlog D-02 |
| F7 circular NOT NULL refs, no provisioning owner, status divergence | Provisioning job + order documented; `auth_identity.status` is the only access switch; `disabled` reason | 03, 02, backlog D-05 |
| G in-flight idempotency replay; EDIT not auditable | Key claimed first (IN_PROGRESS) → 409 + Retry-After; history has before/after | 02, 03, backlog P-01 |
| K P-01 too big; no lockfile owner; L-01 untestable in Wave 1; seed missing auth_identity; stale LocalStack text | P-01/P-02 split; F-01 owns lockfile + pnpm catalog; L-02 added; D-05 seeds auth; outcome text fixed | backlog |
| Overrule 1: drop `GET /cards` from create path | Removed; `card_id` from proven-owned txn. `GET /cards` stays (owner requirement), used by back-office | 01, 04 |
| Overrule 8: single-AZ honesty, cost is a lower bound | Stated in 01/06; total ≈ $225 lower bound | 06 |
| Missing: correlation-id log injection | Validation regex | 05, backlog S-01 |
| Missing: per-customer auto-accept abuse | `autoAcceptMaxPer90Days` cap | 04 |

## Accepted — logged (backlog "Accepted PR-01 findings")
Event ordering via version, malware scanning, back-office human identity, per-user rate limits,
outbox lag alarm, Lambda concurrency.

## Partially accepted / rejected
- **Overrule 2 — local JWKS verification instead of `/validate`: rejected.** The owner explicitly
  required `Auth POST /validate`. It also centralises the sub→user mapping and the disable switch
  (F7 makes `auth_identity.status` the single access control, which local JWKS alone cannot
  enforce). Cost is one cached hop. Revisit if p95 latency in M4 shows the hop matters.
- **Overrule 7 — Postgres RLS as a second wall: deferred to M4, not rejected.** M1's control is the
  ownership predicate plus a negative e2e matrix on every endpoint. RLS needs per-request `SET`
  plumbing through the pool, which is a meaningful complexity cost for a POC. The reviewer is right
  that it is stronger, and I have no counter-argument beyond scope.
- **Overrule 6 — per-aggregate sequence number:** partially accepted. Dispute `version` serves as
  the sequence, so no extra column is needed.
- **Reviewer cost of $225–235:** this is a `[guess]`. I have adopted "≈$225 lower bound" pending
  verification of the internal ALB price in M3. I have not adopted the reviewer's number as fact.

## Open questions for the owner (added to state.json)
- **Q-12:** Add `GET /dispute/{transactionId}`? The charter promises "see where it stands", and the requested API has no read. Recommended: yes.
- **Q-13:** POPIA retention vs "financial rows never deleted". The description text, idempotency response bodies and evidence files may hold PII. A retention period and erasure policy are needed.
- **Q-08 (updated):** auto-accept threshold 200 ZAR and the new cap of 3 per 90 days.
