# 04 — Dispute Rules

Implemented only in `packages/dispute-domain` (pure TypeScript, no I/O, clock injected).
Every value below is exported config from that package; nothing else hard-codes them.

## Reason codes
`FRAUD`, `NOT_RECEIVED`, `DUPLICATE`, `INCORRECT_AMOUNT`, `CANCELLED_SUBSCRIPTION`, `DEFECTIVE_GOODS`, `OTHER`.

## Eligibility (ADR-020, ADR-021 — owner UI flow 2026-10-10)
Two pure functions in `@cd/dispute-domain`. Both services use them, so the UI button and the
backend cannot disagree.

### `evaluateTransactionEligibility(txn, card, existingDispute, now)` → `{ allowed, reason? }`
Needs no user input. Used by **transactions** (the `disputable` flag on every row) and by **disputes** on create.
Evaluated in this order; the first failure is returned:
| # | Rule | Reason code |
|---|---|---|
| 1 | No dispute has **ever** existed for this transaction, in any status including WITHDRAWN | `ALREADY_DISPUTED` (POST → 409) |
| 2 | Card is not expired: `isCardExpired(card, now)` is false (valid through the last day of the expiry month, UTC). Derived from month/year only; `card.status` has no EXPIRED value | `CARD_EXPIRED` |
| 3 | Transaction `status = POSTED` | `TXN_NOT_POSTED` |
| 4 | Transaction `type` in `PURCHASE, ATM_WITHDRAWAL, FEE` (not REFUND) | `TXN_TYPE_NOT_DISPUTABLE` |
| 5 | `now - postedAt ≤ 120 days` (inclusive, whole UTC days) | `OUTSIDE_WINDOW` |

Card states BLOCKED and CANCELLED do **not** block a dispute, because fraud usually follows a block.
Only expiry does (owner decision).

### `validateDisputeInput(input)` → ok | code
Used only by disputes on create and edit.
| Rule | Code |
|---|---|
| `reasonCode` in list | `INVALID_REASON` |
| `description` 10–2000 chars | `INVALID_DESCRIPTION` |

**No partial disputes** (ADR-024): a dispute always covers the full transaction amount. There is no amount input.

### Enforcement
- **One dispute per transaction, ever.** DB: `unique (transaction_id)` on `dispute` (a plain unique
  constraint, not a partial one). This also closes PR-01 F1 (double refund): no re-dispute is possible after any outcome.
- WITHDRAW is therefore final. The UI must warn before withdrawing.
- `isCardExpired` is exported from `@cd/dispute-domain`. users uses it for the `expired` flag in
  `GET /me` and `GET /cards`, so there is one definition of expiry.

## State machine
```
SUBMITTED ──review──► UNDER_REVIEW ──resolve(ACCEPTED)──► RESOLVED_ACCEPTED
    │                      │        └─resolve(REJECTED)──► RESOLVED_REJECTED
    │                      └─withdraw──► WITHDRAWN
    ├─withdraw──► WITHDRAWN
    └─edit──► SUBMITTED (version+1)
```
| From | Action | Actor | To |
|---|---|---|---|
| SUBMITTED | EDIT | USER (owner) | SUBMITTED |
| SUBMITTED, UNDER_REVIEW | WITHDRAW | USER (owner) | WITHDRAWN |
| SUBMITTED | REVIEW | AGENT only | UNDER_REVIEW |
| SUBMITTED, UNDER_REVIEW | RESOLVE | AGENT only | RESOLVED_ACCEPTED / RESOLVED_REJECTED |
| any terminal | any | any | rejected `INVALID_TRANSITION` |

Terminal: `RESOLVED_ACCEPTED`, `RESOLVED_REJECTED`, `WITHDRAWN`.
Applying the same transition already applied (e.g. REVIEW on UNDER_REVIEW by the same event) is a
no-op success, so consumers are idempotent.

## Concurrency (PR-01 F2)
- Every state change runs in one DB transaction: `SELECT … FOR UPDATE` on the dispute row, then
  `applyAction`, then `UPDATE … WHERE version = :expected`. The first writer wins and the loser gets 409/412.
- Internal review/resolution calls carry `expectedVersion`. A USER WITHDRAW racing a SYSTEM RESOLVE
  is decided by whichever commits first. The loser sees the new state, and gets `INVALID_TRANSITION`
  if that state is terminal.
- The clock is the DB's: `now` passed to the domain is `select now()` from the same transaction, never the task clock.

## Review (ADR-016, ADR-033 — no automation changes status)
- New disputes stay `SUBMITTED` until a back-office agent picks one from `GET :8081/review-queue` and calls
  `PUT /dispute/{transactionId}/review` (→ UNDER_REVIEW), then `/resolution`.
- Nothing auto-accepts, auto-rejects or auto-reviews. `SYSTEM_RULE` actors exist only for evidence and
  retention housekeeping (EVIDENCE_REJECTED, EXPIRED, ERASED), never for status changes.
- The customer may edit only while SUBMITTED, i.e. until an agent picks it up.

Removed over time: auto-accept threshold, per-customer cap, DUPLICATE auto-match, the auto-review Lambda, the
auto-decide endpoint, and the transactions `/internal/transactions` context route. PR-01 F5 is moot.
PR-01 F2's `expectedVersion` on review/resolution remains.

## Edits
- Allowed fields: `description`, `reasonCode`; same validation as create.
- `If-Match` version must equal current; success increments `version`.
- Each edit writes a history row (`from = to = SUBMITTED`, action `EDIT`, `before`/`after` jsonb of the changed fields) — audit of what changed (PR-01 G).
