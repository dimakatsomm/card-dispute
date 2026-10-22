# 05 — Security

## Threat model (STRIDE, abridged)
| Threat | Example | Control | Test |
|---|---|---|---|
| Spoofing | Forged/expired JWT; id token used as access token; token from another user pool | auth verifies signature (JWKS), `iss`, `token_use=access`, `client_id` allow-list, `exp` | auth unit tests per reason code |
| Spoofing (s2s) | User token used on `GET /cards` | `requireService(scope)` guard + route only on service port 8081 (reachable from outside the services only through the ALB `:8081` listener, whose SG admits just the two Lambdas) + SG | e2e: user token → 403 |
| Tampering | Edit someone else's dispute; lost update | Ownership predicate; `If-Match` version | e2e: other user → 404; stale → 412 |
| Repudiation | "I didn't withdraw that" | Insert-only `dispute_status_history` with actor | DB role test: UPDATE/DELETE denied |
| Info disclosure (IDOR) | `GET /transactions?cardId=<other user's card>` | Every query `WHERE user_id = principal.userId` | e2e per endpoint with second user |
| Info disclosure (PII) | Email in logs/events | pino redact list; events carry `userId` only | log snapshot test |
| DoS | Huge pages / unbounded filters; evidence flood | `limit ≤ 100`; WAF rate rule; ≤5 evidence, ≤10 MB | validation tests |
| EoP | Service role reading another schema | Per-schema DB roles, no cross grants | migration test: cross-schema SELECT fails |
| Replay | Retried POST creates 2 disputes | `unique (transaction_id)` → 409 ALREADY_DISPUTED | concurrent-POST integration test |
| Malicious upload | Executable renamed .pdf; malware in a PDF; oversized file | Presigned PUT signs Content-Type, Content-Length and sha256 (S3 enforces them); file lands in an isolated quarantine bucket; malware scan; evidence-intake checks magic bytes before promoting; only the clean copy goes to the evidence bucket; disputes never reads the bytes | evidence-intake tests (renamed exe, EICAR test file, checksum mismatch) |
| Cardholder data in evidence (PCI) | Receipt photo shows a full PAN | Bytes never transit the disputes service or the ALB; buckets SSE-KMS, private, access only by evidence-intake (quarantine) and back-office read role (evidence) | IAM policy review; S3 access logs |

## Identity
- Cognito user pool: admin-create-only; users authenticate via hosted UI / PKCE (client concern). The `spa` client's access tokens last 15 min, refresh 1 day (dev).
- Service tokens (`svc-*` clients) are valid 60 min, not 15 (ADR-065): Cognito bills $0.00225 per M2M token request and the auth-client refreshes lazily, so a busy caller costs about $1.6/month at 60 min against about $6.6 at 15 min (orchestration/verify-m3.md 2e).
- Resource server scopes (format `<resource-server-id>/<scope>`): `auth/validate`, `users/cards.read`, `users/contact.read`, `transactions/read`, `disputes/read`, `disputes/evidence.write`. The back-office scopes `disputes/review` and `disputes/resolve` are not created in AWS while the back office is deferred (ADR-064); they stay in `docs/openapi`.
- One confidential app client per caller: `svc-users`, `svc-transactions`, `svc-disputes`, `svc-notifier`, `svc-evidence-intake`. Client secrets are raw strings in Secrets Manager (`cd/dev/cognito/<client>`). The grants live in one file, `infra/terraform/modules/cognito/grants.json`, kept equal to the mock-issuer grants by a parity test; the mock-issuer's `svc-backoffice` is local-only and excluded from that test by an explicit deferred-clients list (ADR-064).
- `e2e` client (dev only, ADR-062): `ALLOW_ADMIN_USER_PASSWORD_AUTH` and nothing else, so user tokens come only from IAM-signed `AdminInitiateAuth`. Only the `gha-e2e` role and the net-probe task role may call it, scoped to this pool. It has no hosted-UI flow.
- Scope grants (least privilege, revised PR-01 F4): every ECS service that runs auth-client → `auth/validate`; evidence-intake → `disputes/evidence.write`; transactions → `users/cards.read`, `disputes/read`; disputes → `users/cards.read`, `transactions/read`; notifier (`svc-notifier`) → `users/contact.read`, `disputes/read` (current version, to skip stale status emails). No back-office client exists in AWS (ADR-064). (Transactions regained `users/cards.read` for the `disputable` flag — ADR-021.)
- Back-office human identity (PR-01 missing): deferred with the back office. When built, it resolves via a Cognito **user** in group `agents`, so `actor_id` = the agent's sub, not a shared client. Until then no dispute can be resolved (nothing changes status automatically).
- Token revocation: user access token ≤ 15 min + auth-client cache ≤ 60 s. Disabling `auth_identity.status` takes effect within 60 s. Accepted window. Service tokens live 60 min but carry only their scopes and are not user sessions.

## Network
- VPC with public subnets (NAT) and private subnets (ALB, ECS, Aurora, Lambdas). No interface endpoints: Cognito, ECR, Secrets Manager and Logs are reached through one NAT.
- **One internal ALB** (ADR-059): `:80` is the CloudFront VPC origin, `:8081` is the Lambda path to the service routes. Its SG admits `:80` only from `CloudFront-VPCOrigins-Service-SG` and `:8081` only from the evidence-intake and dispute-notifier SGs (SG references, never CIDRs).
- SG rules: ALB → users/transactions/disputes/web app port, and `:8081` to users and disputes only. auth ← users/transactions/disputes only.
  users ← ALB, transactions, disputes (notifier Lambda via ALB `:8081`). disputes ← ALB `:8081` (evidence-intake Lambda), transactions. Aurora ← service SGs, retention-sweeper Lambda, dev-tools. Lambdas and dev-tools have no ingress, and dev-tools is not granted the service ports; net-probe proves the denials (ADR-067).
- ALB `:80` target groups point at port 8080 only. The `:8081` listener defaults to a fixed 404 and forwards only `/users/*` (users) and `/dispute*`, `/disputes` (disputes). Service-to-service calls use Service Connect (`http://<svc>:8081`). Customer and service routes are registered on separate Fastify instances, so a misrouted request finds no handler (ADR-026).
- Plain HTTP inside the VPC is accepted in dev because the data is mock only (ADR-059); fix it before real data.
- Browser → CloudFront uses the default `*.cloudfront.net` certificate (no custom domain, ADR-046), which forces the viewer TLS minimum to `TLSv1` (ADR-068); modern browsers still negotiate TLS 1.2/1.3. Accepted because dev holds mock data only. A custom domain + ACM certificate (us-east-1) enables `TLSv1.2_2021` and is required before real data. `/api/*` is HTTPS-only at CloudFront (no HTTP-to-HTTPS redirect), so a bearer token is never sent in clear. CloudFront → ALB uses a CloudFront **VPC origin**, so the ALB is internal and the hop stays on the AWS network: `edge_origin_mode = vpc_origin` (V-M3: supported in af-south-1, no extra charge on pay-as-you-go). Creation order: ALB active, then the VPC origin (up to 15 min to deploy), then the ALB SG ingress from `CloudFront-VPCOrigins-Service-SG`. The `public_alb` fallback (public ALB, CloudFront prefix list + secret header, about +$7/month) is not used. Aurora `rds.force_ssl=1`, and clients connect with `sslmode=verify-full` against the vendored RDS CA bundle.
- **WAF is in M3, tuning is M4.** The CloudFront web ACL (us-east-1) runs CommonRuleSet, KnownBadInputs and an IP rate rule, with `SizeRestrictions_BODY` in COUNT mode on `/api/dispute*`. M4 (H-01) tunes false positives and adds per-user limits.

## Data
- KMS CMKs: `cd-data` (Aurora, Secrets, SQS, logs) and `cd-evidence` (S3).
- Malware scanning (verified available in af-south-1): GuardDuty Malware Protection for S3 on the quarantine bucket, with object tagging enabled **before** first upload. evidence-intake is triggered by the EventBridge event `GuardDuty Malware Protection Object Scan Result` (delivered at least once, so it must be idempotent) and promotes **only** on `NO_THREATS_FOUND`. `THREATS_FOUND`, `UNSUPPORTED`, `ACCESS_DENIED` and `FAILED` → REJECTED. A bucket policy denies `s3:GetObject` on objects without `GuardDutyMalwareScanStatus=NO_THREATS_FOUND`, except for the GuardDuty role. Price: $0.099/GB + $0.000237/object after the free 1 GB / 1,000 objects a month.
- S3 quarantine bucket: Block Public Access, CORS allows `PUT` from the web origin only, lifecycle deletes objects after 1 day, no read access except evidence-intake.
- S3 evidence: Block Public Access, bucket policy denies non-TLS requests, default SSE-KMS on every object (no deny-non-KMS PUT: the intake CopyObject sends no SSE header), versioning, lifecycle: delete after 365 days (interim retention, ADR-017).
- Secrets Manager (encrypted with `cd-data`): nine per-role DB credentials (`cd/dev/db/<role>`) + Cognito client secrets. **DB credential rotation is deferred**: the db-bootstrap task sets the role passwords and re-sets them on every run; there is no rotation Lambda. Revisit before real data.

## IAM (least privilege, no `*` resources)
| Principal | Allowed |
|---|---|
| each ECS task role | read own secrets; KMS decrypt `cd-data` (via Secrets Manager) |
| disputes task role | + `s3:PutObject` on the quarantine bucket only — used solely to **sign** presigned URLs (no reads, no evidence-bucket access); `sqs:SendMessage` to the dispute-notifications queue only (ADR-033) |
| notifier Lambda | own queue; own client secret; `ses:SendEmail` on verified identity |
| GuardDuty malware-protection role | read + tag objects in the quarantine bucket; `kms:Decrypt` on the quarantine key (verify-claims-02 #2) |
| evidence-intake Lambda | `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on the quarantine bucket (ListBucket so a missing key reads as 404); `s3:PutObject` on `evidence/*` in the evidence bucket; KMS for both keys; own client secret |
| `gha-infra-plan` (OIDC, sub `ref:refs/heads/main`) | `ReadOnlyAccess`, state read/lock, writes under `plans/`; denied seed-user secrets and evidence/quarantine reads. Plans are stored in S3 (`plans/<sha>`), never as a GitHub artifact (ADR-060) |
| `gha-infra-apply` (OIDC, sub `environment:dev`) | Writes only for the services in `infra/terraform/modules/README.md` on `cd-` / `cd/` names; creates roles only under path `/cd/` with boundary `cd-workload-boundary`; cannot change itself, the boundary, the OIDC provider or the state bucket; af-south-1 and us-east-1 only |
| CI publish / deploy roles (OIDC, `ci-roles`) | publish: main only, push to its own ECR repo. deploy: environment `dev`, own ECS service or Lambda only, PassRole of its own roles. None can call `iam:*` or reach another deployable. `gha-run-tools` runs the dev-tools task families; `gha-e2e` calls `AdminInitiateAuth` on the pool, reads seed-user secrets and `cd-ses-events`, and uses Reachability Analyzer |
| Deployment gate | GitHub Environment `dev`: required reviewer, deployment branches `main` only and never `refs/pull/*/merge`, otherwise a PR job could present the `environment:dev` sub (V-M3 10c) |

## Accepted residuals
- `gha-infra-apply` can create roles under `/cd/` with the `cd-workload-boundary`, and that boundary permits `cd/*` secret reads, `cd-dev-*` object access and KMS use. Apply can therefore reach that data indirectly by creating a role and assuming it. Accepted because apply runs only from `main`, in the approval-gated GitHub Environment `dev`. Mitigation path: narrow the boundary's S3 and KMS statements to named buckets and keys (`bootstrap/boundary.tf`).
- The quarantine bucket's clean-scan tag is the read control, so only the GuardDuty role may write object tags or upload outside `intake/`; the bucket policy denies everyone else.
- `gha-run-tools` can start the dev-tools task families with `containerOverrides`, so it can run any command as the `dev-seed` task role and read what that role reads: seed-user passwords (synthetic dev users) and the migrator database URLs. IAM has no condition key that forbids overrides. Accepted because the role is reachable only from `main` jobs in the approval-gated Environment `dev`, and the data is dev-only and synthetic.
- The net-probe task carries the `svc-notifier` client secret (ADR-067), so the `gha-run-tools` override residual above also covers that service identity (`users/contact.read`, `disputes/read`). A dedicated probe client is the mitigation if it matters.
- Service, frontend and dev-tools base images are pinned by exact tag (`node:24.22.0-alpine3.24`), not digest, and `apk upgrade` runs at build, so rebuilds are not byte-reproducible; Trivy scans every published image. Lambda base images are digest-pinned.

## Logging
- Structured JSON (pino). Redact: `authorization`, `token`, `email`, `cellphoneNumber`, `name`, `surname`, `*.secret`, `password`.
- Correlation id propagated across HTTP and SQS (`x-correlation-id` message attribute). Inbound ids are validated against `^[A-Za-z0-9-]{8,64}$` and replaced if invalid (log injection, PR-01). Inbound ids validated: `^[A-Za-z0-9-]{8,64}$`, else replaced (log-injection, PR-01).

## Logged for later (PR-01 "what's missing")
| Gap | Where |
|---|---|
| Per-user rate limit (dispute/evidence spam, withdraw/recreate mail-bomb) | M4 — WAF rate rule keyed on token sub + app-level per-user cap on dispute creates |
| Malware scanning of evidence (magic bytes are not enough) | Done: GuardDuty Malware Protection for S3 is available in af-south-1 (V-M3); real scans are proven in E-03 |
| POPIA retention/erasure | Decided: 1 year then erase PII fields + evidence (03 Retention, ADR-017); sweeper in M2 |
| Row-level security as second wall on transactions/disputes | Deferred to M4 — app predicate + negative e2e tests are the M1 control; RLS adds per-request `SET` plumbing |
| `EventPublishFailed` alarm (publish-after-commit failures) | M2 |
