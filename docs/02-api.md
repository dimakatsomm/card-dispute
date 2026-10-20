# 02 — API Contract

Machine-readable source of truth: `docs/openapi/<service>.yaml` (OpenAPI 3.1), written in task C-04.
This doc is the human summary; if they disagree, raise it — do not pick one silently.

## Conventions
- JSON, `camelCase` fields. IDs are UUIDs. Money is a **string** decimal (`"125.50"`) + `currency` (ISO 4217).
- Timestamps ISO-8601 UTC.
- Errors: RFC 9457 `application/problem+json` — `{ type, title, status, detail, code, correlationId }`.
- Every response carries `x-correlation-id` (echoed from request or generated).
- Auth header: `Authorization: Bearer <token>`.
- Not-owned resources → **404** (never reveal existence). Missing/invalid token → **401**. Wrong principal type or scope → **403**.

## Client flow → API (owner-defined UI flow, 2026-10-10, ADR-019)
| # | Screen / action | Calls |
|---|---|---|
| 1 | Sign in | Cognito hosted login (authorization code + PKCE) → access token. No custom auth endpoint for the client. |
| 2 | Home: accounts + recent transactions | `GET /me` (accounts → cards) + `GET /transactions` (all accounts) |
| 3 | Select account → its cards + transactions | cards from the `GET /me` response (no call) + `GET /transactions?accountId=` |
| 4 | Select card → its transactions | `GET /transactions?cardId=` |
| 5 | Dispute a transaction | button shown when `item.disputable.allowed`; form → `POST /dispute/{transactionId}` (JSON: reason, description, optional file **declarations**) → response carries one presigned upload URL per file → client `PUT`s each file straight to S3 (ADR-028) |
| 6 | Disputes view + timeline | `GET /disputes` (list) → select → `GET /dispute/{transactionId}` (detail + timeline) |
| — | Edit / withdraw / add more evidence | `PUT /dispute/{transactionId}`; `POST /dispute/{transactionId}/evidence` (declare files → upload URLs) |

**One dispute per transaction, ever** (ADR-020), so `transactionId` identifies exactly one dispute.

## Route exposure — two ports, token decides (ADR-026)
No `/internal` path prefix and no trusted header. Every service runs **two listeners**:
- **Public port 8080**: attached to the public ALB. Registers **customer routes only**; every route requires a **user** principal.
- **Service port 8081**: reachable only via ECS Service Connect (and the internal ALB for Lambdas). Registers
  **service routes only**; every route requires a **service** principal with the listed scope.

The same path can exist on both ports with different handlers (e.g. `GET /transactions`). The port decides
which handler, and the token is checked on every request. A service-only route is not registered on the public
port, so it doesn't exist from the internet (404) even with a stolen service token.

| Service | Route | Port | Principal | Scope |
|---|---|---|---|---|
| auth | `POST /validate` | service | service | `auth/validate` |
| users | `GET /me` | public | user | — |
| users | `GET /cards` | service | service | `users/cards.read` |
| users | `GET /users/{userId}/contact` | service | service | `users/contact.read` |
| transactions | `GET /transactions` | public | user | — (enriched list with `dispute`/`disputable`) |
| transactions | `GET /transactions` | service | service | `transactions/read` (plain rows by `userId` + `transactionIds`, makes no further calls) |
| disputes | `GET /disputes` | public | user | — (customer list) |
| disputes | `GET /disputes` | service | service | `disputes/read` (batch lookup by `userId` + `transactionIds`) |
| disputes | `POST /dispute/{transactionId}` | public | user | — (JSON; optional evidence declarations → presigned URLs) |
| disputes | `GET /dispute/{transactionId}` | public | user | — |
| disputes | `PUT /dispute/{transactionId}` | public | user | — (edit / withdraw) |
| disputes | `POST /dispute/{transactionId}/evidence` | public | user | — (declare more files → presigned URLs) |
| disputes | `PUT /dispute/{transactionId}/evidence/{evidenceId}` | service | service | `disputes/evidence.write` (scan/validation result from evidence-intake) |
| disputes | `GET /review-queue` | service | service | `disputes/review` (back-office queue) |
| disputes | `PUT /dispute/{transactionId}/review` | service | service | `disputes/review` |
| disputes | `PUT /dispute/{transactionId}/resolution` | service | service | `disputes/resolve` |
| all | `GET /health`, `GET /ready` | both | none | — |

Notation: `GET :8081/transactions` means the service-port route.

Rules:
- Public port: a service token → 403. Service port: a user token → 403. A missing or wrong scope → 403.
- An `x-*` header is never used for access decisions. The public ALB has no header-based routing.
- `/validate`: the caller sends its own service token in `Authorization`. auth verifies it locally, then validates the subject token in the body.

## Service-to-service call graph
```
transactions ──GET /cards──────────► users        (card expiry, once per request, cached 60 s)
transactions ──GET /disputes (service port)► disputes    (dispute state for the txn ids on the page, 1 batch call)
disputes     ──GET :8081/transactions?userId=&transactionIds=► transactions (create + list/detail enrichment; raw, no s2s calls)
disputes     ──GET /cards───────────► users        (on create: card expiry)
all          ──POST /validate───────► auth
```
transactions ↔ disputes call each other, but never in a loop. The enriched public list calls disputes.
disputes calls only the **raw** internal txn lookup, which calls nobody. Rule: internal endpoints never
make s2s calls. Accepted coupling; revisit with a read model if it hurts.

---

## Auth — `POST /validate`
Headers: `Authorization: Bearer <calling service's token with auth/validate>` — missing/invalid → 401, wrong scope → 403.
Request: `{ "token": "<jwt being validated>" }`
200: `{ "valid": true, "principalType": "user", "authId": "uuid", "userId": "uuid", "scopes": [], "exp": 1760000000 }`
200 (service): `{ "valid": true, "principalType": "service", "clientId": "…", "scopes": ["users/cards.read"], "exp": … }`
200 invalid: `{ "valid": false, "principalType": "none", "reason": "expired|bad_signature|wrong_issuer|wrong_client|wrong_token_use|unknown_subject|disabled" }`
400: malformed body.
Rules: only Cognito **access** tokens accepted (id tokens rejected). `client_id` must be in the allow-list.
`auth_identity.status` is the single access-control switch (PR-01 F7).
Principal type is decided by which client allow-list the token's `client_id` is on (user clients vs service clients), not by the presence of `sub`. User principals return the token's actual scopes. JWKS unreachable → 500 (callers treat any non-200 as unavailable → 503).

## Users — `GET /me`
200:
```json
{
  "userId": "uuid", "name": "Thandi", "surname": "Nkosi",
  "email": "thandi@example.com", "cellphoneNumber": "+27821234521",
  "accounts": [
    { "accountId": "uuid", "accountType": "CHEQUE", "accountNumberMasked": "****4821", "currency": "ZAR", "status": "ACTIVE",
      "cards": [ { "cardId": "uuid", "accountId": "uuid", "brand": "VISA", "cardType": "DEBIT", "last4": "4821",
                   "expiryMonth": 9, "expiryYear": 2028, "expired": false, "status": "ACTIVE" } ] }
  ]
}
```
- `expired` is computed server-side with `isCardExpired()` from `@cd/dispute-domain` (valid through the last day of the expiry month, UTC). The UI never does date maths.
- Never returns card `token`. Email/phone unmasked to their owner, redacted in logs.
- 404 `NOT_FOUND` if the validated user has no profile row (provisioning gap).

## Users — `GET /cards` (service port)
Query: `userId` (required), `accountId?`, `cardId?`.
200: `{ "cards": [ { "cardId", "accountId", "userId", "brand", "cardType", "last4", "expiryMonth", "expiryYear", "expired", "status" } ] }`
403 for user tokens or missing scope. 400 if `userId` missing.
Callers: transactions (disputable flag), disputes (create validation).

## Users — `GET /users/{userId}/contact` (service port)
200: `{ "userId", "email", "name" }`. 404 unknown.

## Transactions — `GET /transactions`
Query (all optional): `accountId`, `cardId`, `transactionId`, `from`, `to` (on `transactionAt`),
`status` (`PENDING|POSTED|DECLINED|REVERSED`, repeatable), `minAmount`, `maxAmount`, `limit` (1–100, default 25), `cursor`.
No filter = all the caller's accounts. Ordering: `transactionAt desc, transactionId desc`. Cursor = opaque base64 of last (transactionAt, id).
200:
```json
{ "items": [ {
    "transactionId", "accountId", "cardId", "amount": "125.50", "currency": "ZAR",
    "merchantName", "mcc", "type": "PURCHASE", "status": "POSTED", "transactionAt", "postedAt",
    "dispute": { "disputeId": "uuid", "status": "UNDER_REVIEW" } | null,
    "disputable": { "allowed": false, "reason": "ALREADY_DISPUTED" }
  } ],
  "nextCursor": "…" | null }
```
- `disputable` is computed with the **same** `evaluateTransactionEligibility()` from `@cd/dispute-domain` that `POST /dispute` uses (ADR-021), so the button and the backend cannot disagree on rules.
- `disputable.reason` ∈ eligibility codes (04-dispute-rules) or `UNAVAILABLE`.
- **Degradation:** if users or disputes doesn't answer within 2 s, the page is still returned, with `dispute: null` and `disputable: { allowed: false, reason: "UNAVAILABLE" }` for every item. It fails closed for the button and never fails the list.
- `accountId`/`cardId` not owned → empty page (not an error). 400 on invalid filters.

## Disputes — `GET /disputes`
Query: `status?` (repeatable), `accountId?`, `cardId?`, `limit` (1–100, default 25), `cursor`. Ordering: `updatedAt desc`.
`accountId`/`cardId` are resolved **through transactions** (ADR-025). The dispute itself stores only `transactionId`:
1. load the caller's dispute `transaction_id`s (status filter applied);
2. `GET :8081/transactions?userId=&transactionIds=…&accountId=|cardId=` (chunks of 100) → matching transactions;
3. page the caller's disputes whose `transaction_id` is in that set; reuse those rows for `transaction`.
If transactions is unavailable and an account/card filter was requested → 503 (a filter cannot be answered without it). Unfiltered lists degrade to `transaction: null`.
An `accountId`/`cardId` the caller doesn't own → empty list.
200:
```json
{ "items": [ { "disputeId", "transactionId", "status", "reasonCode",
  "transaction": { "accountId", "cardId", "amount", "currency", "merchantName", "transactionAt" } | null,
  "lastEvent": { "type": "UNDER_REVIEW", "at": "…" }, "createdAt", "updatedAt" } ],
  "nextCursor": "…" | null }
```

## Disputes — `GET /dispute/{transactionId}`
200: dispute resource (below) + `timeline`, ascending:
```json
"timeline": [
  { "type": "SUBMITTED",      "at": "…", "by": "CUSTOMER" },
  { "type": "EVIDENCE_ADDED", "at": "…", "by": "CUSTOMER", "detail": { "fileName": "receipt.pdf" } },   // when the file passed scanning
  { "type": "EVIDENCE_REJECTED", "at": "…", "by": "BANK", "detail": { "fileName": "x.pdf", "reason": "MALWARE|TYPE_MISMATCH|CHECKSUM|SIZE|SCAN_FAILED" } },
  { "type": "EDITED",         "at": "…", "by": "CUSTOMER", "detail": { "fields": ["description"] } },
  { "type": "UNDER_REVIEW",   "at": "…", "by": "BANK" },
  { "type": "RESOLVED_ACCEPTED", "at": "…", "by": "BANK", "detail": { "note": "…" } }
]
```
- Built from `dispute_status_history` (+ evidence rows). `by` is `CUSTOMER` or `BANK` only; agent ids are never exposed.
- `type` ∈ `SUBMITTED | EDITED | EVIDENCE_ADDED | EVIDENCE_REJECTED | UNDER_REVIEW | RESOLVED_ACCEPTED | RESOLVED_REJECTED | WITHDRAWN`.
- `ETag: "<version>"`. 404 none / not owned.

## Disputes — `POST /dispute/{transactionId}`
`Content-Type: application/json` (ADR-028: presigned uploads; supersedes ADR-027 multipart)
```json
{ "reasonCode": "FRAUD",
  "description": "…(10–2000 chars)",
  "evidence": [ { "fileName": "receipt.pdf", "contentType": "application/pdf", "sizeBytes": 183422, "sha256": "<hex>" } ] }
```
- `evidence` is optional, 0–5 items. `contentType` ∈ `application/pdf | image/jpeg | image/png`, `sizeBytes` 1–10 485 760, `sha256` 64 hex.
- Unknown fields (e.g. `disputedAmount`) → 400. The **full transaction amount** is always disputed (ADR-024).
- No `Idempotency-Key`: a retry hits `unique (transaction_id)` → 409 `ALREADY_DISPUTED`; the client then calls `GET /dispute/{transactionId}` (ADR-023).

201: dispute resource + `ETag` + upload instructions:
```json
"uploads": [ { "evidenceId": "uuid", "method": "PUT", "url": "https://…quarantine…/intake/{transactionId}/{evidenceId}…", "headers": {
    "Content-Type": "application/pdf", "Content-Length": "183422", "x-amz-checksum-sha256": "<base64>" },
  "expiresAt": "…(+10 min)" } ]
```
- The client `PUT`s each file to its URL with exactly those headers. S3 rejects a different type, length or checksum (signed headers).
- Files land in the **quarantine bucket** at `intake/{transactionId}/{evidenceId}` (ADR-055; the key is not derived from the file name). They are scanned and checked by `evidence-intake` and then move to the evidence bucket (see 01-architecture). Until then the evidence item has `status: "PENDING"`.
- The dispute is created even if the client never uploads. Unused upload slots expire (`EXPIRED`) and don't count toward the 5-file cap.

Errors:
- 404 transaction not found / not owned
- 409 `ALREADY_DISPUTED` — any dispute exists for this transaction, in any status (ADR-020)
- 422 `NOT_ELIGIBLE` with `code`: `TXN_NOT_POSTED | TXN_TYPE_NOT_DISPUTABLE | OUTSIDE_WINDOW | CARD_EXPIRED` (eligibility only)
- 400 validation (unknown fields, >5 declarations, bad size/type/sha256); `code` is `VALIDATION_FAILED`, `INVALID_REASON` (unknown reason code) or `INVALID_DESCRIPTION` (not 10–2000 characters), the same as `PUT`
- 503 upstream unavailable (each upstream call has one 2 s overall deadline)
- 503 `UPLOAD_SIGNING_UNAVAILABLE` — the dispute **was created** and DisputeCreated published, but URLs could not be signed; re-declare via `POST /dispute/{transactionId}/evidence` (ADR-054)

Dispute resource:
```json
{ "disputeId", "transactionId", "status": "SUBMITTED", "reasonCode", "description",
  "transaction": { "accountId", "cardId", "amount", "currency", "merchantName", "transactionAt", "postedAt" } | null,
  "evidence": [ { "evidenceId", "fileName", "contentType", "sizeBytes", "status" } ],
  "version": 1, "createdAt", "updatedAt", "resolvedAt": null, "resolutionNote": null }
```
`transaction` is read live from transactions (one batch call per response). If transactions is unavailable it is `null` and the dispute data is still returned.

## Disputes — `PUT /dispute/{transactionId}`
Headers: `If-Match: "<version>"` (required).
Body (one of):
- edit: `{ "action": "EDIT", "description"?, "reasonCode"? }` — only while `SUBMITTED`.
- withdraw: `{ "action": "WITHDRAW", "note"? }` — while `SUBMITTED` or `UNDER_REVIEW`. **Final:** the transaction can never be disputed again (UI must warn).
200 updated resource + new ETag. 404 none / not owned. 412 stale. 428 missing If-Match. 409 `INVALID_TRANSITION`.

## Disputes — `POST /dispute/{transactionId}/evidence`
JSON `{ "evidence": [ …same declaration shape, 1–5… ] }`. Allowed while `SUBMITTED` or `UNDER_REVIEW`.
Cap: at most 5 evidence items per dispute that are `PENDING` or `STORED` → 413 `TOO_MANY_FILES`.
Retry-safe (ADR-050): a declaration matching an existing `PENDING` item of the dispute (same sha256, size, type) gets a fresh presigned URL for that same `evidenceId`, so retries never consume extra slots.
201: `{ "uploads": [ …same shape as create… ] }`.

## Service-port endpoints
- `PUT /dispute/{transactionId}/evidence/{evidenceId}` (scope `disputes/evidence.write`, caller: evidence-intake Lambda) → body `{ "result": "STORED" | "REJECTED", "reason"?: "MALWARE|TYPE_MISMATCH|CHECKSUM|SIZE|SCAN_FAILED", "sha256", "sizeBytes", "contentType" }` (the facts evidence-intake observed; required with `STORED`, optional with `REJECTED` because intake cannot observe them when the scan verdict is `ACCESS_DENIED`, `FAILED` or `SKIPPED` or `HeadObject` fails; `reason` is required with `REJECTED`), response 200 `{ "evidenceId", "status": "STORED" | "REJECTED", "s3Key"? }`. disputes compares the reported facts with the declared ones: a `STORED` result whose facts differ is recorded `REJECTED` (`TYPE_MISMATCH`, `SIZE` or `CHECKSUM`) and answered 200 with `status: "REJECTED"`, so the caller acts on the response. `s3Key` = `evidence/{disputeId}/{evidenceId}`, set by disputes only when `STORED` and never read from the body; the caller copies the object there. Writes `EVIDENCE_ADDED` or `EVIDENCE_REJECTED` to the history. Idempotent: the same result again → 200 no-op. An `evidenceId` that is not this dispute's → 404. A result for an `EXPIRED`/`ERASED` item, or one conflicting with the settled result → 409.
- `GET :8081/transactions?userId=&transactionIds=&accountId?&cardId?` (≤ 100 ids; transactions, scope `transactions/read`) → `{ items: [raw txn] }`, only that user's rows that also match the optional account/card filter (non-matching or missing ids simply absent). Makes no s2s calls.
- `GET :8081/disputes?userId=&transactionIds=` (≤ 100 ids) → `{ "items": [ { "transactionId", "disputeId", "status", "version" } ] }`. Used by transactions for the `dispute` / `disputable` fields and by the notifier (scope `disputes/read`) to read the current `version` and skip stale status emails (ADR-055).
- `PUT /dispute/{transactionId}/review` → SUBMITTED → UNDER_REVIEW. Body `{ "actor": {"type":"AGENT","id"}, "expectedVersion", "note"? }` — AGENT only (ADR-033)
- `GET :8081/review-queue?status=SUBMITTED|UNDER_REVIEW&limit&cursor` (scope `disputes/review`) → disputes across all customers, oldest `createdAt` first, for the back-office
- `PUT /dispute/{transactionId}/resolution` → `{ "outcome": "ACCEPTED|REJECTED", "note", "actor": {"type":"AGENT","id"}, "expectedVersion" }` — AGENT only.
All writes idempotent: repeating an applied transition returns 200 with current state. Stale `expectedVersion` → 412.
