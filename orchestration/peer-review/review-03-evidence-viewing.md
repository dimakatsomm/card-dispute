# Review 03 — Agent evidence viewing (BO-10)

Reviewer stance: adversarial. Tags: `[verified]` = read in the repo this session (file named), `[recall]` = from memory of AWS behaviour, not re-checked against AWS docs this session (no public docs were fetched), `[guess]` = inference.
Canaries K1, K2, K3 re-checked and correct [verified: security/main.tf `DenyDisputesTaskDecrypt`; migration 003 constraint `(status = 'STORED') = (s3_key is not null)` plus the trigger nulling the key on ERASED; frontend/docker-entrypoint.sh CSP has `frame-src 'none'` and `object-src 'none'`).

## 1. Fatal flaws

**F1. The design cannot reach auth `/validate` from the Lambda, so step 1 of the flow is not buildable as written.** [verified]
- The `:8081` ALB listener forwards only `/users/*` and `/dispute*` (alb/main.tf `service_rules`).
- The SG flow table (security/main.tf `flows`, `lambda_service_port_flows`) lets Lambdas reach only the ALB, and the ALB reach only users and disputes on 8081. `auth ← users/transactions/disputes only` (docs/05 Network).
- "Reaching auth and disputes like the notifier" is wrong. The notifier calls users and disputes plus the Cognito token endpoint, never auth.
- Fixing it needs a new auth-8081 target group, a listener rule, an SG flow, and an `auth/validate` grant for a new `svc-evidence-viewer` client. That exposes auth's validate surface to a Lambda that sits behind an internet-facing path. The design budgets none of it.
- The alternative of verifying the JWT locally drops the `auth.agent_identity` ACTIVE switch and the `ambiguous_role` check (ADR-071), which are the actual agent access control. Not acceptable.

**F2. "302 to the presigned URL" is impossible, and the top-level-navigation plan contradicts it.** [verified for the SPA facts, recall for browser behaviour]
- The agent token is a bearer token held by the SPA (OIDC PKCE, no cookie). A link click or new-tab navigation sends no `Authorization` header, so the viewer cannot authenticate it.
- A `fetch()` that follows a 302 to the evidence bucket fails CORS: the evidence bucket has no CORS config (evidence-buckets/main.tf) and `connect-src` lists only the quarantine origin (docker-entrypoint.sh).
- Only the `{url}` JSON shape works. The SPA then needs a programmatic anchor click or `window.open`; `window.open` after an `await` risks the popup blocker [recall].
- Open question 2 therefore has one answer: `{url}`, with `Cache-Control: no-store` on that response.

**F3. Option B's boundary is mostly illusory against the threat it is sold on, a compromised disputes service.** [verified architecture, guess on exploit]
- Under B, disputes is the source of the `s3_key` the viewer signs. A compromised disputes can answer the viewer's lookup with any key.
- Agent bearer tokens already transit disputes (`/agent/*` is on the disputes public port, ADR-071). A compromised disputes can therefore harvest a valid agent token and drive the viewer itself.
- B's real gain over A is "the attacker needs a live agent token and the viewer's request shape". That is small, and it is bought with an internet-reachable function holding standing read on every evidence object.
- B is only meaningfully better if the viewer pins the key shape against the request (see §4 item 1) and the attacker model is "disputes bug", not "disputes RCE".

**F4. The audit design fails the PCI row it cites.** [verified]
- One log line is written at URL-mint time, not at byte-access time.
- Lambda log retention is capped at 30 days (lambda-fn `log_retention_days` validation allows 1, 3, 5, 7, 14, 30), and the dev sizing is 7 days (docs/06). PCI DSS asks for 12 months of audit history, 3 months immediately available [recall].
- docs/05's PCI mitigation says "S3 access logs", but the evidence bucket skips access logging (evidence-buckets/main.tf `checkov:skip=CKV_AWS_18`) and no CloudTrail data events are configured.
- Nothing in the design proves who actually read which object. "Every dispute state change is auditable and never lost" (CLAUDE.md §1) is not extended to evidence views, and the repo already has an insert-only DB pattern for exactly this.

**F5. "Retention erasure stays effective" is false as an S3 statement.** [verified]
- The sweeper does not touch S3 (docs/03 line 213). Erasure only nulls `s3_key` in the DB, and bytes persist until the 365-day lifecycle plus the 30-day noncurrent window (evidence-buckets `expire-evidence`, `noncurrent_evidence_days = 30`).
- The DB gate does stop the viewer minting URLs for ERASED rows. The design's wording ("cannot be fetched even if an old URL is replayed after expiry") is meaningless, because S3 rejects expired URLs regardless.
- The real exposure is the inverse. A STORED row on a dispute older than the lifecycle points at an object that is gone (a delete marker, so S3 answers 404/NoSuchKey), and the viewer would hand out a dead URL.
- Not fatal to ship, but the claim must be corrected, and the pre-existing bytes-outlive-erasure gap should be recorded rather than relied on.

## 2. Per-claim verdict

### A. B vs A: "worth the extra deployable" — qualified yes, but for a different reason than stated
- A's "per-request least privilege via session policy narrowed to one object" is not a security boundary against the party that matters. The caller supplies the session policy, so a compromised disputes assumes the role with no restriction. [recall: session policies restrict the session, chosen by the AssumeRole caller]
- The existing `DenyDisputesTaskDecrypt` matches `aws:PrincipalArn` of the disputes task role. An assumed-role session's principal ARN is the reader role's ARN [recall], so the Deny would not catch it, and A would silently void K1. The design is right that A weakens the boundary to "any evidence by assuming a role".
- B's argument is real only against a bug-level compromise of disputes (see F3). It moves risk to a new internet-facing function with standing read on everything. A compromised viewer can read all evidence; a compromised disputes under A can read all evidence. Equal blast radius, different exposure surface.
- The design omits a cheaper variant of B (§4 item 2): disputes validates the agent, audits, and then invokes the viewer Lambda directly with IAM invoke permission, so no new ALB path, no auth reachability, and no second place that validates agent principals.
- Also unaddressed: ADR-071's `onRoute` backstop restricts agent guards to disputes and `/agent/*` paths. A second component that validates agent principals breaks that invariant, so the ADR amendment must say so. [verified: ADR-071 text]

### B. Request flow — weakest, and it does have holes
- **Token validation** (F1): not reachable as designed.
- **302 vs JSON** (F2): JSON only.
- **IDOR across disputes**: the design lets the viewer take an evidence id from the agent. The lookup must join `(transactionId, evidenceId)` and 404 on mismatch. The viewer must then verify the returned key equals `evidence/<transactionId>/<evidenceId>`, as evidence-intake already pins its copy target (`evidenceKey` regex in disputes-client.ts). [verified] The DB constraint only says `s3_key like 'evidence/%'`, so the shape is not DB-enforced.
- **Confused deputy**: the viewer calls disputes with its own service token, so disputes sees "svc-evidence-viewer asks for key X" with no agent identity. Attribution is a caller-supplied field disputes cannot attest. This is another argument for disputes owning authN, audit and the lookup in one agent-guarded route (§4 item 2).
- **ALB rule path**: the existing service rules are `/disputes` and `/dispute/*` only. A route like `/disputes/{id}/evidence/...` would not match and would hit the fixed 404. [verified: alb/main.tf `service_rules`]
- **Token replay**: nothing new (15-minute bearer, auth-client cache ≤ 60 s). The per-URL replay window is bounded by expiry and is not a flaw.
- **Referer/history leakage**: low. The SPA sends `Referrer-Policy: no-referrer` [verified]. A 60-second URL in browser download history is already expired. The more realistic leak is the Lambda or any proxy logging the JSON response body; require "never log the URL".
- **Platform fit** [guess]: an ALB-fronted Lambda target needs the target-group type, an invoke permission for ELB, and the ALB-event response format. Fine, but a cost the "tiny Lambda" framing hides.

### C. Presigned URL hardening — mostly sound, with gaps
- 60-second expiry: S3 validates expiry at request start, and an in-flight download continues [recall; low confidence, verify in the AWS docs]. Slow-link risk is therefore the first byte, not the 10 MB transfer. The SPA must mint the URL on click, not on page load.
- Temporary credentials cap the URL's life: a URL signed by a role session expires when the credentials do [recall]. Lambda credentials near rotation could produce URLs shorter than 60 s. [guess] Cheap to test.
- `response-content-disposition=attachment; filename="<evidenceId>.<ext>"` and `response-content-type` are signed query parameters and fine [recall]. Derive the extension and content type from a hardcoded 3-entry map keyed on `declared_content_type`, never echo the DB string. The `declared_*` check constraint on type exists [verified], so this is defence in depth.
- Missing: `response-cache-control=no-store, private` (S3 supports it as a `response-*` override [recall]).
- `X-Content-Type-Options` cannot be set on an S3 response (the design is right [recall]). Attachment disposition plus top-level download means the browser never renders the bytes in an origin of ours; that is acceptable. Note the file is still opened locally by the agent. Not a web risk, but an endpoint risk for PAN-bearing files.
- SSE-KMS: a presigned GET needs `kms:Decrypt` for the signer, because S3 decrypts as the requester, and SigV4 only [recall]. The design's "key policy grants Decrypt to exactly that role" is wrong as written. The existing `AccountUseViaS3` statement already allows the account root, i.e. IAM-delegated, for all `use_actions` including `kms:Decrypt` via S3 [verified]. The new Allow is redundant, and the only thing restricting Decrypt is IAM absence plus the disputes-only Deny.
- Missing: no resource policy on the evidence bucket restricts reads to named principals (it contains only `DenyNonTls`) [verified]. Add a deny-unless-principal statement (intake, viewer) so the "only viewer reads" claim is enforced in the bucket, not only by not-granting.
- Network: a presigner makes no network call to S3 or KMS. The "S3/KMS via NAT" requirement and any new `s3_egress` entry are unnecessary unless you add a HEAD (§3). [recall for the offline-signing fact]

### D. Retention and state — partially wrong claim (F5)
- `STORED at request time` does stop minting for ERASED, PENDING, REJECTED and EXPIRED rows [verified: K2].
- TOCTOU between lookup and presign: at most 60 seconds, and bytes persist anyway, so not meaningful.
- Versioning is enabled on the evidence bucket [verified]. A presigned GET without `versionId` serves the current version only. After the 365-day expiry the current version is a delete marker (404), while noncurrent versions linger 30 more days with the plaintext recoverable by any privileged role. Pin nothing; just document it.
- The viewer returns a dead URL for STORED rows whose object has expired. Either HEAD first (requires S3 egress or a gateway endpoint) or let the UI treat the S3 404 as "file no longer available".
- Question 3 (re-check dispute state): yes, restrict to non-terminal disputes (SUBMITTED, UNDER_REVIEW per state-machine.ts) and, I would argue, `pickedUpBy = this agent`. That aligns viewing with need-to-know and with `expectedEvidenceDigest`. [guess on policy preference]

### E. Audit and abuse — not enough as designed (F4)
- One log line is neither durable (retention above) nor proof of access.
- Rate limiting: the CloudFront rule today is an IP rate rule, with per-user limits deferred to H-01 [verified: docs/05]. An agent with a 15-minute token can mint evidence URLs for every dispute in the queue. 60-second expiry does not rate-limit minting.
- Cheap fix: an insert-only `evidence_view` table in the disputes schema, written by the lookup route before it returns the key, so no row means no key (fail closed), with an app-level per-agent cap counted from that table. The DB role pattern already exists (`dispute_status_history` insert-only). [verified for the pattern]

### F. Missing / Option C
- C was dismissed for a weak reason. "Whoever holds the CloudFront key mints all access" is equally true of the viewer role. C's real merits are response headers (nosniff, CSP sandbox, cache-control) and no KMS Decrypt grant to a Lambda. Its real costs are the key group secret, the OAC plus KMS grant, and a CloudFront behaviour that sits on the public path. Still not worth it for dev; reject it with the right argument. [guess]
- VPC endpoints: none needed if the viewer only signs (see C). The viewer needs egress to Cognito (NAT) and the internal ALB only.
- Cost: negligible Lambda cost. The real cost is roughly 6 small Terraform and pipeline changes (role, key policy, Lambda, ALB rule + SG + target group, Cognito client, deploy role) for one download link.

## 3. What's missing

1. How the SPA receives the URL and clicks it (F2), including the popup-blocker and error-state UX.
2. How the viewer authenticates to auth, or why it does not need to (F1).
3. A durable, access-time audit trail (F4): an insert-only DB table, S3 data events or access logs on the evidence bucket, and a retention horizon longer than 30 days.
4. A bucket-level principal restriction and an explicit statement that K1 (`DenyDisputesTaskDecrypt`) is unchanged and must stay unchanged under B.
5. A migration or grant for the new disputes lookup route (read-only on `dispute_evidence`; check it does not widen `disputes_app` update columns).
6. The interaction with `expectedEvidenceDigest`: viewing an item that then changes status between read and resolution.
7. Handling for expired or missing objects, and for large PDFs on slow links.
8. Whether `fileName` (customer-supplied, shown to agents in the existing detail contract) should be shown at all next to PAN-risk content. [guess]
9. Tests: customer and service tokens refused, mismatched `(transaction, evidence)` pair, the key-shape pin, and a test that K1 still denies disputes.
10. A statement about agent endpoints: files that may contain a PAN end up on the agent's disk.

## 4. Where I'd overrule you

1. Keep B only if the viewer pins the key to `evidence/<txId>/<evidenceId>` from the request path and treats whatever disputes returns as untrusted. Otherwise B is A with extra steps.
2. Prefer **B′**: add an agent-guarded route on the disputes public port, `GET /agent/disputes/{transactionId}/evidence/{evidenceId}/view`. Disputes does validation (existing `requireAgent`), the dispute-state check, an insert-only audit row and a rate cap, then invokes the viewer Lambda with `lambda:InvokeFunction` (IAM only the disputes task role may call) passing only `{transactionId, evidenceId, key}`. The Lambda verifies the key shape and presigns. Result: no new ALB path, no auth reachability, no `disputes/evidence.read` scope, one place that validates agents, and the SPA gets `{url}` from an endpoint it already knows how to call.
   - Residual: a compromised disputes can invoke the Lambda directly, as under A. State that plainly in the ADR, and mitigate with the bucket principal restriction and the audit trail, not with the claim that disputes cannot read evidence.
3. Reject A for the documented reason that session policies are caller-controlled and that the existing Deny would not match the assumed role.
4. Drop 302 from the design. `{url}` only.
5. Add `response-cache-control`, drop the NAT-to-S3/KMS requirement, and delete the "old URL replay" retention argument.
6. Restrict viewing to non-terminal disputes, ideally picked up by the same agent.

## 5. Your own uncertainty

- I did not fetch AWS documentation. Everything tagged `[recall]` (expiry checked at request start, temporary-credential expiry capping the URL, `aws:PrincipalArn` for assumed-role sessions, `response-cache-control` support, SSE-KMS decrypting as the requester, presigning being offline) should be confirmed against the S3 presigned-URL, IAM global-condition-key and KMS docs before the ADR cites them.
- I did not check whether the actual agent contract exposes `evidenceId` to the SPA in the detail response, though `Evidence` in disputes.public.yaml lists `evidenceId` [verified], so the SPA likely has what it needs.
- I did not verify that auth-client works from a Lambda against a validate endpoint (evidence-intake uses the service-token client only), nor the ALB-to-Lambda event format details.
- My claim that agent tokens "transit disputes" is based on ADR-071 putting `/agent/*` on the disputes public port; I did not check whether CloudFront or nginx terminates them first. If it does not, F3 stands.
- The scale of the compromised-disputes scenario is a threat-model judgement; if the owner scopes the threat to "bug in a route" rather than "task compromise", B regains most of its value and my F3 downgrades to a major issue.
