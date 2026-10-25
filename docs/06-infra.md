# 06 — Infrastructure

Terraform, region **eu-north-1** (default-enabled; moved from af-south-1 on 2026-10-25 so the account can stay on the AWS Free plan, ADR-069), one env `dev`.
Versions: see the verified table below (filled by verify-claims).

## Layout
```
infra/terraform/
  bootstrap/           state bucket (S3, versioned, KMS), GitHub OIDC provider, gha-infra-plan / gha-infra-apply, permissions boundary — applied once by the owner (OWN-4)
  modules/             interface contract: modules/README.md; one README per module that needs one
    network/           VPC, 2 AZs, public + private subnets, 1 NAT (dev), S3 gateway endpoint
    security/          KMS keys cd-data + cd-evidence, every security group
    cognito/           user pool, resource servers, spa + svc-* + e2e clients, client secrets (grants.json)
    aurora/            Serverless v2 cluster, force_ssl, RDS master secret, nine role secrets
    ecr/               nine repositories (immutable tags, scan on push, keep 10)
    ecs-cluster/       cluster, Service Connect namespace cd.internal
    ecs-service/       reusable: task def (+ migrate task def), service at desired 0, Service Connect, target groups, autoscaling, roles
    alb/               ONE internal ALB: :80 (CloudFront VPC origin) + :8081 (Lambdas), path rules (ADR-059)
    edge/              CloudFront (+ /api strip function), VPC origin, WAF web ACL (us-east-1)
    messaging/         SQS queues + DLQs (notifications, evidence-intake, retention-scheduler)
    evidence-buckets/  quarantine bucket (CORS PUT, 1-day lifecycle) + evidence bucket (versioned, 365-day lifecycle), policies, GuardDuty malware protection plan, EventBridge rule → evidence-intake
    lambda-fn/         reusable: container-image function, role, alias live, ESM / schedule; created only when its key is in lambda_image_uris
    ses/               email identity dimakatsomm@icloud.com (sender + verified test recipient; sandbox) — ADR-046; events → EventBridge → cd-ses-events
    observability/     SNS cd-alarms (email), dashboard cd-dev, alarms, budget
    ci-roles/          GitHub OIDC roles: publish, deploy, run-tools, e2e
    dev-tools/         one-shot task definitions db-bootstrap, dev-seed, net-probe on the dev-tools image (ADR-061)
  envs/dev/            providers, backend, variables, dev.tfvars (no secrets); main.tf/workloads.tf/outputs.tf wire the modules (I-WIRE)
```

## Decisions recorded in M3
| Id | Decision |
|---|---|
| ADR-059 | One internal ALB. `:80` is the CloudFront VPC origin; `:8081` (default 404, SG admits only the two Lambda SGs) forwards `/users/*`, `/dispute*`, `/disputes` for the Lambdas. Plain HTTP inside the VPC, mock data only |
| ADR-060 | Infra plan runs on `main` only with the read-only role and is stored in S3 (`plans/<sha>`), never as an artifact; output masked; PRs run offline checks only |
| ADR-061 / 067 | `dev-tools` image (ECR repo `cd-dev-tools`, source `local/seed`) runs one-shot tasks `db-bootstrap`, `dev-seed`, `net-probe`. net-probe runs twice (dev-tools SG: expects refusals; dispute-notifier SG: expects 403/401 as specified) because the SG matrix is not widened for tooling |
| ADR-062 | `e2e` Cognito client, `ALLOW_ADMIN_USER_PASSWORD_AUTH` only, used via IAM-signed `AdminInitiateAuth`; dev only |
| ADR-063 | Owner rulings: managed NAT; budget $200 with alerts; CI masks account id and role ARNs; base WAF in M3 (tuning M4); SNS alarm channel in I-13; X-Ray dropped |
| ADR-064 | No back-office Cognito clients or scopes in AWS |
| ADR-065 | `edge_origin_mode = vpc_origin`; `svc-*` tokens 60 min, spa/e2e 15 min; task size per service (default 0.25 vCPU / 0.5 GB); park procedure; GitHub Environment `dev` deployment branches `main` only |
| ADR-066 | Lambda roles, log groups and the sweeper scheduler role exist in phase A; only function-level resources wait for images. Container health check `/health`; ALB target health `/ready` with lenient thresholds |
| ADR-069 | Region moved from af-south-1 to **eu-north-1** (owner, 2026-10-25) so the account can stay on the AWS Free plan (af-south-1 is an opt-in region). Dev holds mock data only; real customer data in the EU would need a POPIA cross-border transfer review first. Preflight (2026-10-25) found the Free plan account's AWS-managed SCP denies GuardDuty and IAM OIDC providers, which the evidence scan and all CI-to-AWS access need, so the owner **upgraded to the Paid plan**; credits still apply, the design is unchanged. The account is closed after the presentation (runbook "Teardown and account closure") |
| ADR-068 | CloudFront on the default `*.cloudfront.net` certificate (no custom domain, ADR-046) forces viewer TLS minimum `TLSv1`; accepted because dev holds mock data only. A domain + ACM certificate (us-east-1) enabling `TLSv1.2_2021` and HTTPS on the internal hop are required before real data. WAF label rule blocks oversize bodies outside `/api/dispute*` (+$1/month). `PriceClass_All` |

Tracing: X-Ray is dropped (ADR-063). Correlation ids in structured logs are the tracing story; Lambda tracing is PassThrough.

## Dev sizing (decided, ADR-005)
| Resource | Setting |
|---|---|
| AZs | 2 |
| NAT | 1 gateway — **single-AZ egress**: an AZ outage cuts Cognito token/JWKS calls for the whole dev environment (accepted risk) |
| ECS tasks | 5 services (auth, users, transactions, disputes, web), created at `desired_count` 0; the deploy pipeline starts them at 1. Autoscale 1–2 @ 60% CPU only when `enable_service_autoscaling = true` (after the first deploy). ARM64 |
| Task size | 0.25 vCPU / 0.5 GB default, a per-service variable; resize only a service that throttles under load (Service Connect proxy headroom, ADR-065) |
| Aurora | Serverless v2 PG 18, min ACU 0.5 (`aurora_min_acu`), max 2; 1 writer, no reader; deletion protection on |
| Logs | 7-day retention |
| Lambda | Node.js runtime (version per verify-claims), ARM64, 256 MB |

## Delivery
Superseded in detail by **docs/09-repo-and-delivery.md §4** (per-deployable pipelines, manual approval on every deploy, container Lambdas). Summary below kept for context.
- GitHub Actions: on PR → lint, typecheck, unit + integration tests, `terraform fmt -check`, `validate`, `test`, tflint, checkov, image build + scan. **No AWS access and no `plan` on PRs** (ADR-060).
- On main → build + push images to ECR (tag = git sha), run DB migrations as a one-off ECS task per service, ECS rolling deploy. `infra.yml` plans on main, stores the plan in S3, waits for approval and applies that plan.
- Auth to AWS via GitHub OIDC; no long-lived keys.
- Step-by-step rollout, park/unpark and operations: **docs/11-dev-runbook.md**.

## Migrations
- Per-service migration folder; runner in `backend/packages/db`. Each service migrates its own schema using a
  migration role (DDL) distinct from its runtime role (DML).
- Schemas, roles and grants are created by a bootstrap migration run with the master secret.

## Verified versions & availability
Checked against primary sources on 2026-10-09. Sources are in `orchestration/verify-claims-01.md`. Re-check before M3.

| Item | Value | Note |
|---|---|---|
| Node.js | **24** (Active LTS) | Node 26 becomes LTS on 2026-10-28; stay on 24 for dev |
| Lambda runtime | **container image on `public.ecr.aws/lambda/nodejs:24`** (ADR-030; managed `nodejs24.x` no longer used) | `nodejs26.x` is preview only. arm64 in eu-north-1 is documented but the container-image package type is not stated for the region: runbook phase B proves it |
| Aurora PostgreSQL | **18.x** Serverless v2 | Native `uuidv7()` exists in PG 18, so we use it (no app-side UUIDs) |
| Aurora min ACU | 0.5 budgeted. 0 (auto-pause) needs PG 16.3+ and is likely but **unconfirmed** on PG 18 in eu-north-1 | 24x7 task connections stop it from pausing; the park procedure sets `aurora_min_acu = 0` |
| CloudFront VPC origin to an internal ALB | available in eu-north-1 (AWS VPC origins Region table, checked 2026-10-25), no extra charge on pay-as-you-go | `edge_origin_mode = vpc_origin`; flat-rate plans are not used (VPC origins need Business, $200) |
| Cognito M2M | $0.00225 per token request, no per-client fee (removed 2025-11-03) | `svc-*` access tokens 60 min |
| ECS Fargate ARM64 + Service Connect | available in eu-north-1 | Service Connect has no extra charge |
| Cognito | M2M + custom scopes on every plan | $0.00225 per token request, no free tier, so tokens must be cached |
| SES | **API only** (SMTP exists in eu-north-1 but is not used) | Use `@aws-sdk/client-sesv2`. Sandbox: 200 per day, 1 per second, verified recipients only |
| Terraform / hashicorp/aws | >= 1.10 (1.16.5 verified) / **~> 6.68** | S3 backend uses `use_lockfile`, which needs >= 1.10 |
| TypeScript | **6.0.3** (not 7.x) | typescript-eslint 8.72 supports TS < 6.1 (F-01, 2026-10-19) |
| Lambda base image | `public.ecr.aws/lambda/nodejs:24` (arm64) | build with `--provenance=false` |
| GuardDuty Malware Protection for S3 | eu-north-1 availability and Free plan eligibility **unverified** (V-M3b) | $0.099/GB + $0.000237/object after the free tier; 100 GB max object size |
| fastify / zod / vitest | 5.12.5 / 4.6.5 / 5.0.3 | zod **4** API |
| @testcontainers/postgresql | 12.2.0 | |
| pino / aws-jwt-verify | 10.4.0 / 5.2.1 | migrations use a custom SQL runner in @cd/db (ADR-047) |
| pnpm | 12.10.1 | |
| @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | ⚠ UNVERIFIED — add to next /verify-claims | presigned PUT with signed `x-amz-checksum-sha256` (ADR-028) — confirm checksum headers can be signed into a presigned PUT |
| AWS WAF body-size rule | `SizeRestrictions_BODY` in COUNT mode on `/api/dispute*` (API bodies are small JSON; files go straight to S3); false positives are reviewed in M4 | |
| LocalStack | ⚠ needs an account + auth token; free Hobby plan is non-commercial; no SES v2 | See Q-11. Default: **moto** server for SQS and S3 locally; SES mocked at the SDK boundary |

Cognito token and JWKS endpoints are public, so tasks and Lambdas need NAT egress (or PrivateLink support, which is unverified).

## Cost estimate (af-south-1 prices from V-M3 on 2026-10-21; eu-north-1 re-price pending, V-M3b)

Unit prices are from the AWS Price List API (orchestration/verify-m3.md, item 11). Assumptions: 24x7, one task per service, Service Connect proxy fits inside 0.25 vCPU / 0.5 GB, `svc-*` token validity 60 min, about 20 GB NAT traffic, WAF = web ACL + 3 rules, 19 secrets, 3 KMS keys.

| Line | $/month | Note |
|---|---|---|
| Aurora Serverless v2 @ 0.5 ACU | 63 | 58.40 compute + storage + I/O |
| NAT gateway + EIP + data | 46 | 41.61 + 3.65 + about 1 |
| Fargate ARM, 5 × 0.25 vCPU / 0.5 GB | 49 | 5 × $9.73 |
| Internal ALB | 25 | 21.90 + light LCU |
| CloudFront | 0.5 | inside the always-free 1 TB / 10M requests |
| WAF | 9 | web ACL + 3 rules + requests |
| Cognito M2M | 7 | 15 min validity would give about 21–25 |
| Secrets Manager | 7.6 | 19 secrets |
| KMS | 3.3 | |
| CloudWatch | 6.5 | |
| Other (ECR, S3, SQS, SES, GuardDuty, Scheduler, Reachability Analyzer) | 5 | |
| **Total** | **≈ $222** (range 210–235) | |

Scenarios against the 222 baseline:

| Scenario | Delta | Total |
|---|---|---|
| Service Connect proxy forces 0.5 vCPU / 1 GB on the four Service Connect services (risk R1) | +39 | ≈ 261 |
| `svc-*` clients left at 15 min token validity | +14 to +20 | ≈ 238 |
| `public_alb` fallback (not used) | +7 | ≈ 229 |
| Park lever: services at `desired_count` 0 for about 60% of hours | ≈ −29 | ≈ 193 |
| Park lever: Aurora `aurora_min_acu = 0` while idle (if PG 18 supports it) | up to −55 | ≈ 170–205 |

The Cognito "+$30 per M2M client" contingency is deleted: the per-client fee was removed on 2025-11-03.

### Budget and the park procedure
The owner budget is **$200/month** (ADR-063), about $22 (11%) below the 24x7 cost. Terraform creates the budget with these notifications to `dimakatsomm@icloud.com`: forecast 100%, actual 80% ($160) and actual 100%. **Expect them**: the forecast alert fires in the first week and actual 80% at about day 22 of a month run 24x7. They are information, not incidents.

To stay under $200, park the environment when it is not in use and unpark it before a demo or e2e run. The two levers are `desired_count` 0 on the five ECS services and `aurora_min_acu = 0`. The exact steps are in docs/11-dev-runbook.md, "Park and unpark". NAT, the ALB, WAF, Secrets Manager and KMS keep billing while parked (about $90/month), and Aurora keeps its storage, so parking never takes the bill below that.

Next tier (not planned): a second task per service adds about $49 of Fargate; Aurora at 2 ACU adds up to $175.

**VPC endpoints vs NAT:** about 9 interface endpoints × 2 AZs × $9.56 ≈ $172, against one NAT at about $46. NAT plus the free S3 gateway endpoint wins for dev.
**Cognito cost trap:** an auth-client that skipped caching would request a token per call. At 1M calls that is $2,250. Token caching is an acceptance criterion in S-04.
