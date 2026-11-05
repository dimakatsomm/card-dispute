# Peer Review Brief 03 — Agent evidence viewing (BO-10)

## Your role
You are an adversarial reviewer. **Do not be agreeable.** If a section is fine, write "no issue" and move on.
Tag **every** claim: `[verified]` (checked in the repo or a primary source this session), `[recall]`, `[guess]`.
"I don't know" is a correct answer, especially for S3 presigned-URL behaviour, KMS/SSE semantics, CloudFront OAC and
STS session policies, where memory is often stale.

Read the real files, not this summary:
- `orchestration/designs/BO-10-evidence-viewing.md` (the design under review)
- `CLAUDE.md` (§2 hard rules, §7 guardrails), `docs/05-security.md` (threat model incl. the PCI row), ADR-071 in `docs/06-infra.md`
- `infra/terraform/modules/security/main.tf` (evidence key policy, `DenyDisputesTaskDecrypt`), `infra/terraform/modules/evidence-buckets/main.tf`, `infra/terraform/envs/dev/workloads.tf`
- `backend/disputes/migrations/003_dispute_evidence.sql`, `004_retention_erasure.sql`
- `frontend/docker-entrypoint.sh` (CSP), `backend/lambdas/evidence-intake/**` (an existing Lambda calling a disputes service-port route)

Do not modify any file.

## Pre-verified canary facts (checked in the repo 2026-11-04; flag only if you believe them wrong)
- K1: The evidence key policy has a `DenyDisputesTaskDecrypt` statement denying the disputes task role `kms:Decrypt` (security/main.tf ~166).
- K2: `dispute_evidence.s3_key` is set only when status is STORED and is nulled by retention erasure (migrations 003/004).
- K3: The SPA CSP includes `frame-src 'none'` and `object-src 'none'` (frontend/docker-entrypoint.sh).

## Claims to attack (author confidence)
**A. Option B (dedicated evidence-viewer Lambda) is worth its extra deployable over Option A (disputes assumes a reader role)** [medium]. Is the boundary argument real, or does B just move the same risk? What can a compromised viewer do vs a compromised disputes under A?
**B. The viewer's request flow** (validate agent token → disputes service-port lookup with a new `disputes/evidence.read` scope → presign → 302 or {url}) [LOW — weakest, attack first]. Confused-deputy risks, IDOR across disputes, token replay, the URL leaking via Referer/logs/browser history, 302 vs JSON.
**C. Presigned URL hardening** [medium]: 60 s expiry for 10 MB files, `response-content-disposition=attachment` with a generated file name, `response-content-type`, content sniffing without `X-Content-Type-Options`, SSE-KMS decrypt path and key-policy grant.
**D. Retention and state** [medium]: does "STORED at request time" fully prevent access to erased evidence? Races with erasure; versioning on the evidence bucket?
**E. Audit and abuse** [medium]: is one log line per view enough for PCI-sensitive data? Rate limiting before H-01?
**F. Anything missing** (CloudFront option C dismissed too quickly? VPC endpoint needs? cost?).

## Answer structure (fixed)
1. Fatal flaws  2. Per-claim verdict (A–F)  3. What's missing  4. Where I'd overrule you  5. Your own uncertainty
