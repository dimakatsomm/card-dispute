# 05 — Security

## Threat model (STRIDE, abridged)
| Threat | Example | Control | Test |
|---|---|---|---|
| Spoofing | Forged/expired JWT; id token used as access token; token from another user pool | auth verifies signature (JWKS), `iss`, `token_use=access`, `client_id` allow-list, `exp` | auth unit tests per reason code |
| Spoofing (s2s) | User token used on `GET /cards` | `requireService(scope)` guard + route only on service port 8081 (not on ALB) + SG | e2e: user token → 403 |
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
- Cognito user pool: users authenticate via hosted UI / SRP (client concern). Access tokens 15 min, refresh 1 day (dev).
- Resource server scopes: `auth/validate`, `users/cards.read`, `users/contact.read`, `transactions/read`, `disputes/read`, `disputes/review`, `disputes/resolve`, `disputes/evidence.write`.
  (Exact scope string format `<resource-server-id>/<scope>` — verify against Cognito docs.)
- One confidential app client per caller: `svc-transactions`, `svc-disputes`, `svc-backoffice`, `svc-notifier`, `svc-evidence-intake`, `svc-backoffice`. Client secrets in Secrets Manager.
- Scope grants (least privilege, revised PR-01 F4): every ECS service that runs auth-client → `auth/validate`; evidence-intake → `disputes/evidence.write`; transactions → `users/cards.read`, `disputes/read`; disputes → `users/cards.read`, `transactions/read`; notifier → `users/contact.read`; backoffice → `disputes/review`, `disputes/resolve`, `users/cards.read`. (Transactions regained `users/cards.read` for the `disputable` flag — ADR-021.)
- Back-office human identity (PR-01 missing): in M2 the back-office resolves via a Cognito **user** in group `agents` exchanged for the service call, so `actor_id` = the agent's sub, not a shared client. Until then no dispute can be resolved (auto-review only queues).
- Token revocation: access token ≤ 15 min + auth-client cache ≤ 60 s. Disabling `auth_identity.status` takes effect within 60 s. Accepted window.

## Network
- VPC with public subnets (ALB, NAT) and private subnets (ECS, Aurora, Lambdas).
- SG rules: ALB → users/transactions/disputes app port only. auth ← users/transactions/disputes only.
  users ← ALB, transactions, disputes, notifier Lambda. disputes ← ALB, evidence-intake Lambda (via internal ALB). Aurora ← service SGs + retention-sweeper Lambda.
- Public ALB target groups point at port 8080 only. Port 8081 (service routes) accepts traffic only from
  service SGs (Service Connect) and the internal-ALB SG. Customer and service routes are registered on separate
  Fastify instances, so a misrouted request finds no handler (ADR-026).
- TLS 1.2+ browser → CloudFront on the default `*.cloudfront.net` certificate (no custom domain, ADR-046). CloudFront → ALB: **preferred** CloudFront VPC origin, so the ALB is internal and traffic stays on the AWS network (availability in af-south-1 = V-06); **fallback** HTTP origin on a public ALB that accepts only the CloudFront origin-facing prefix list + a secret origin header. That hop is unencrypted, which is acceptable only with mock data and must be fixed (VPC origin or a domain + ACM) before real data. Aurora `rds.force_ssl=1`.

## Data
- KMS CMKs: `cd-data` (Aurora, Secrets, SQS, logs) and `cd-evidence` (S3).
- Malware scanning (verified available in af-south-1): GuardDuty Malware Protection for S3 on the quarantine bucket, with object tagging enabled **before** first upload. evidence-intake is triggered by the EventBridge event `GuardDuty Malware Protection Object Scan Result` (delivered at least once, so it must be idempotent) and promotes **only** on `NO_THREATS_FOUND`. `THREATS_FOUND`, `UNSUPPORTED`, `ACCESS_DENIED` and `FAILED` → REJECTED. A bucket policy denies `s3:GetObject` on objects without `GuardDutyMalwareScanStatus=NO_THREATS_FOUND`, except for the GuardDuty role. Price: $0.099/GB + $0.000237/object after the free 1 GB / 1,000 objects a month.
- S3 quarantine bucket: Block Public Access, CORS allows `PUT` from the web origin only, lifecycle deletes objects after 1 day, no read access except evidence-intake.
- S3 evidence: Block Public Access, bucket policy denies non-TLS and non-KMS puts, versioning, lifecycle: delete after 365 days (interim retention, ADR-017).
- Secrets Manager: per-service DB credentials + Cognito client secrets. Rotation enabled for DB creds.

## IAM (least privilege, no `*` resources)
| Principal | Allowed |
|---|---|
| each ECS task role | read own secrets; KMS decrypt `cd-data`; X-Ray put |
| disputes task role | + `s3:PutObject` on the quarantine bucket only — used solely to **sign** presigned URLs (no reads, no evidence-bucket access); `sqs:SendMessage` to the dispute-events and dispute-notifications queues |
| notifier Lambda | own queue; own client secret; `ses:SendEmail` on verified identity |
| GuardDuty malware-protection role | read + tag objects in the quarantine bucket; `kms:Decrypt` on the quarantine key (verify-claims-02 #2) |
| evidence-intake Lambda | `s3:GetObject`, `s3:DeleteObject` on the quarantine bucket; `s3:PutObject` on `evidence/*` in the evidence bucket; KMS for both keys; own client secret |
| CI deploy role (OIDC) | ECR push, ECS update-service, Lambda update-function-code, terraform state bucket |

## Logging
- Structured JSON (pino). Redact: `authorization`, `token`, `email`, `cellphoneNumber`, `name`, `surname`, `*.secret`, `password`.
- Correlation id propagated across HTTP and SQS (`x-correlation-id` message attribute). Inbound ids are validated against `^[A-Za-z0-9-]{8,64}$` and replaced if invalid (log injection, PR-01). Inbound ids validated: `^[A-Za-z0-9-]{8,64}$`, else replaced (log-injection, PR-01).

## Logged for later (PR-01 "what's missing")
| Gap | Where |
|---|---|
| Per-user rate limit (dispute/evidence spam, withdraw/recreate mail-bomb) | M4 — WAF rate rule keyed on token sub + app-level per-user cap on dispute creates |
| Malware scanning of evidence (magic bytes are not enough) | M2 — verify GuardDuty Malware Protection for S3 availability in af-south-1 |
| POPIA retention/erasure | Decided: 1 year then erase PII fields + evidence (03 Retention, ADR-017); sweeper in M2 |
| Row-level security as second wall on transactions/disputes | Deferred to M4 — app predicate + negative e2e tests are the M1 control; RLS adds per-request `SET` plumbing |
| `EventPublishFailed` alarm (publish-after-commit failures) | M2 |
