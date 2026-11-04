# BO-10 — Agent evidence viewing (design note, for peer review)

Status: **revised after peer review 03 → recommendation is B′** (see response-03), 2026-11-04. Owner scheduled it on 2026-11-04 (ADR-071 rulings). No code until this is
reviewed and an ADR is recorded.

## Goal
An agent viewing a dispute can open each **STORED** evidence file (pdf/jpeg/png) the customer uploaded, so they can
decide FRAUD / NOT_RECEIVED disputes on evidence rather than the description alone. Customers' access is unchanged.

## Constraints we must keep
- **Services never handle evidence bytes** (CLAUDE.md §2 and §7). Bytes go S3 → browser, never through disputes.
- **Disputes can never read evidence today.** The evidence KMS key policy has `DenyDisputesTaskDecrypt`
  (`infra/terraform/modules/security/main.tf` ~166), and `envs/dev/workloads.tf` says "disputes can never read
  evidence". Evidence can contain a full card number (docs/05 threat model, PCI row), so this boundary matters.
- Only an **agent** (ADR-071 principal) may view; customers and services may not use this path.
- Only `STORED` evidence. PENDING, REJECTED, EXPIRED and ERASED never resolve to bytes, and retention erasure must
  stay effective (`s3_key` is nulled on erasure).
- Files are untrusted even after the scan and the magic-byte check: never render them inline in our origin.
- Every view is auditable (agent id, dispute id, evidence id, time).

## The crux
A presigned S3 GET runs with the **signer's** permissions, and the URL itself is a bearer capability to read that
object until it expires. Whoever signs (or holds the signing key) can read evidence. The design question is
therefore *which component may mint read capabilities, and under what checks*.

## Options

**A. Disputes assumes a narrow reader role per request.** New role `cd-evidence-reader` (S3 GetObject on
`evidence/*`, KMS Decrypt via S3), assumable only by the disputes task role. On each view disputes calls
`sts:AssumeRole` with a session policy narrowed to the one object ARN, then presigns a GET (expiry ~60 s,
`response-content-disposition=attachment`).
- For: one deployable, small change; per-request least privilege; bytes never touch disputes.
- Against: disputes can now mint read access to **any** evidence object (it chooses the key), so the
  "disputes can never read evidence" boundary becomes "disputes can read any evidence by assuming a role". A
  compromise of disputes now exposes evidence.

**B. Dedicated evidence-viewer component signs; disputes never holds read capability (recommended).** A small
Lambda (`evidence-viewer`, container image like the others) behind a new ALB path `/agent/evidence/*`, holding the
reader permissions itself. Per request it:
1. validates the caller's token with auth `/validate` and requires `principalType: agent`;
2. asks disputes on the **service port** for the evidence record (new route, new scope `disputes/evidence.read`,
   returns status + `s3_key` only for STORED items of that dispute), so disputes stays the source of truth;
3. presigns a GET for exactly that key (expiry ~60 s, attachment disposition, response content type from the
   declared type) and returns `302` to it, or `{url}` for the SPA to open in a new tab;
4. logs `agent evidence viewed` (agentId, disputeId, evidenceId).
- For: disputes keeps its "cannot read evidence" boundary; the only component that can read evidence is a tiny
  single-purpose function with no other routes; the key policy grants Decrypt to exactly that role.
- Against: a new deployable (image, pipeline, alarms), one more service-port route and scope, a new ALB rule.
  More moving parts to roll out (fits the existing Lambda pattern: evidence-intake and the notifier already call
  service-port routes with client-credentials tokens).

**C. CloudFront in front of the evidence bucket with signed URLs.** OAC-protected distribution/behaviour for the
evidence bucket; disputes (or a signer) signs CloudFront URLs with a key pair.
- For: no per-request STS; can add response headers (attachment, CSP, nosniff) at the edge.
- Against: whoever holds the CloudFront private key can mint access to all evidence for the key's lifetime (worse
  than A unless the signer is isolated as in B); new distribution/behaviour and key management; SSE-KMS with OAC
  needs a key-policy grant to CloudFront.

## Recommendation (superseded by B′ in response-03 — kept for the record)
**B**, with these specifics:
- Lambda in the private subnets, reaching auth and disputes like the notifier (internal ALB `:8081`), and S3/KMS via
  NAT (no new endpoints in dev).
- IAM: `s3:GetObject` on `evidence/*` only; `kms:Decrypt` on the evidence key with `kms:ViaService = s3`; the key
  policy adds an Allow for this role only (keeps `DenyDisputesTaskDecrypt`). No ListBucket.
- Presigned URL: 60 s expiry; `response-content-disposition=attachment; filename="<evidenceId>.<ext>"` (never the
  customer's file name, avoids header injection and PII in logs); `response-content-type` from the declared type.
- SPA: a "Download" link per STORED item in the agent detail; opens via top-level navigation in a new tab, so the
  SPA CSP needs no change. No inline preview (CSP stays `frame-src 'none'`, `object-src 'none'`).
- Audit: one structured log line per view; a CloudWatch metric for views per agent (anomaly alarm later, H-01).
- Rate limit: reuse the per-user WAF rule planned in H-01; until then the 60 s expiry plus the audit log.
- Retention: the viewer refuses anything not STORED in disputes at request time, so erased evidence (s3_key null)
  cannot be fetched even if an old URL is replayed after expiry.

## Open questions for the review
1. Is B's extra deployable justified versus A's simplicity, given evidence may contain card numbers?
2. 302 redirect vs returning `{url}`: does either leak the URL to logs/referrers we don't control?
3. Should the viewer also re-check the dispute is in an agent-visible state, or is "STORED + agent" enough?
4. Is 60 s expiry realistic for large files (10 MB) on slow links? S3 checks expiry at request start only (recall).
5. Any risk from serving `image/*` with attachment disposition (content sniffing)? Add `x-content-type-options`
   is not possible on presigned S3 responses (recall) — acceptable with attachment disposition?

## Rough decomposition (after review)
BO-10a contract + ADR-072 · BO-10b disputes service route + scope · BO-10c evidence-viewer Lambda · BO-10d Terraform
(role, key policy, Lambda, ALB rule, scope, pipeline) · BO-10e SPA download link · BO-10f e2e (agent downloads a
STORED file; customer/service tokens refused; non-STORED refused; URL expiry).
