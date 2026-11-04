# Response 03 — Agent evidence viewing (BO-10)

Reviewer: fresh-context agent on a different model (Sonnet), not an independent second-model CLI. Weight accordingly.

## Reviewer calibration
All canaries (K1–K3) confirmed. Repo claims I re-checked and found right: the `:8081` listener routes only
`/users/*` and `/disputes`, `/dispute/*` (alb/main.tf:32-35), so a Lambda has no path to auth; the retention sweeper
never touches S3 (only the DB guard trigger nulls `s3_key`); Lambda log retention is capped at 30 days
(lambda-fn/variables.tf:41); docs/05's PCI row promises "S3 access logs" that do not exist. S3/STS/KMS behaviour
claims are tagged [recall] by the reviewer and stay unverified here.

## Accepted — changes the design (now B′ in the design note)
- **F1 no path to auth / F3 boundary illusory / F2 302 cannot work** → B′: disputes does the agent check with its
  existing `requireAgent` guard on a new `GET /agent/disputes/{transactionId}/evidence/{evidenceId}/download`, checks
  the dispute and that the item is STORED, writes an audit row, enforces a per-agent rate cap, then **invokes the
  viewer Lambda directly via IAM** (`lambda:InvokeFunction` on that one function) with `{transactionId, evidenceId}`
  only. The viewer derives the key itself as `evidence/<disputeId>/<evidenceId>` from a disputes lookup is NOT needed:
  the key shape is fixed (`evidence/{disputeId}/{evidenceId}`), so disputes passes `{disputeId, evidenceId}` and the
  viewer validates both as UUIDs and builds the key — disputes cannot pass an arbitrary key. Response is `{url}` JSON;
  the SPA opens it from the click handler (no `await` before `window.open`; it pre-opens the tab then sets location).
- **F5 audit** → an insert-only `evidence_view` audit table in disputes (agent_id, dispute_id, evidence_id, at),
  written **before** signing and failing closed; plus CloudTrail S3 **data events** on the evidence bucket so the
  actual byte reads are recorded independently of our code (owner cost call below).
- **F4 option A is worse than stated** → A stays rejected.
- **Smaller**: `response-cache-control=no-store`; generated filename only; viewer needs no S3/KMS egress (presigning
  is local); the key-policy grant is to the viewer role only and the reviewer's point that root delegation already
  exists is noted (no change: IAM on the role is the control).

## Accepted — logged as separate tasks
- **BO-10x (pre-existing gap, not BO-10's)**: retention erasure does not delete evidence bytes; they persist until the
  bucket lifecycle (365 d + 30 d noncurrent). Fix: sweeper deletes the object (and its versions) when it erases, or
  docs stop claiming erasure removes files. Owner decision on approach.
- **docs/05 PCI row** promises S3 access logs that don't exist → correct it (CloudTrail data events if accepted).

## Partially accepted / rejected
- **F6 "replaying an expired URL is meaningless"** — accepted (S3 rejects expired signatures [recall]); the STORED
  check at request time is still what prevents minting new URLs for erased items.
- **C (CloudFront)** — still not chosen: it adds a distribution behaviour and long-lived signing keys for no gain over
  B′ in dev; revisit before real data if edge response headers (nosniff) become a requirement.

## Residual risk, stated plainly
A fully compromised disputes service can still ask the viewer to sign any `{disputeId, evidenceId}` pair. B′ keeps
S3/KMS credentials out of disputes, pins the key shape, rate-limits and audits every view in two independent places,
but it does not make evidence unreachable from a compromised disputes. That is acceptable only with the audit and
alarms; the owner should accept it explicitly.

## Open questions for the owner
1. Accept B′ and its residual risk (above)?
2. CloudTrail S3 data events on the evidence bucket for an independent read log (small per-event cost)?
3. BO-10x: should erasure delete evidence bytes immediately (sweeper gets s3:DeleteObject on evidence/*), or rely on
   the lifecycle and fix the docs?
