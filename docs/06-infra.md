# 06 — Infrastructure

Terraform, region **af-south-1** (opt-in region — must be enabled on the account first), one env `dev`.
Versions: see the verified table below (filled by verify-claims).

## Layout
```
infra/terraform/
  bootstrap/           state bucket (S3, versioned, KMS) + lock; GitHub OIDC role — applied once, manually
  modules/
    network/           VPC, 2 AZs, public + private subnets, 1 NAT (dev), VPC endpoints (S3 gateway)
    security/          KMS keys, SGs
    cognito/           user pool, resource server, scopes, app clients → secrets
    aurora/            Serverless v2 cluster, parameter group (force_ssl), master secret
    ecs-cluster/       cluster, Service Connect namespace, ECR repos
    ecs-service/       reusable: task def, service, SC config, ALB target group (optional), autoscaling, task role
    alb-waf/           ALB, HTTPS listener, path rules, WAF web ACL (AWS managed common rules + rate limit)
    messaging/         SQS queues + DLQs, alarms
    evidence-buckets/  quarantine bucket (CORS PUT, 1-day lifecycle) + evidence bucket (versioned, 365-day lifecycle), policies, GuardDuty malware protection plan, EventBridge rule → evidence-intake
    lambda-fn/         reusable: function, role, event source mapping, log group
    edge/              CloudFront (+ /api strip function), WAF (us-east-1), origin secret header
    ses/               email identity dimakatsomm@icloud.com (sender + verified test recipient; sandbox) — ADR-046
    observability/     log groups (7-day retention), alarms (5xx, p95 latency, DLQ depth > 0), dashboard
  envs/dev/            main.tf wiring modules, dev.tfvars (no secrets)
```

## Dev sizing (decided, ADR-005)
| Resource | Setting |
|---|---|
| AZs | 2 |
| NAT | 1 gateway — **single-AZ egress**: an AZ outage cuts Cognito token/JWKS calls for the whole dev environment (accepted risk) |
| ECS tasks | 1 per service, autoscale to 2 on CPU > 60%; ARM64 if cheaper (verify) |
| Task size | 0.25 vCPU / 0.5 GB |
| Aurora | Serverless v2, min ACU = lowest supported (verify), max 2; 1 writer, no reader |
| Logs | 7-day retention |
| Lambda | Node.js runtime (version per verify-claims), ARM64, 256 MB |

## Delivery
Superseded in detail by **docs/09-repo-and-delivery.md §4** (per-deployable pipelines, manual approval on every deploy, container Lambdas). Summary below kept for context.
- GitHub Actions: on PR → lint, typecheck, unit + integration tests, `terraform fmt -check`, `validate`, `plan`, tfsec/checkov, image build + scan.
- On main → build + push images to ECR (tag = git sha), run DB migrations as a one-off ECS task per service, `terraform apply` (dev), ECS rolling deploy, e2e smoke.
- Auth to AWS via GitHub OIDC; no long-lived keys.

## Migrations
- Per-service migration folder; runner in `backend/packages/db`. Each service migrates its own schema using a
  migration role (DDL) distinct from its runtime role (DML).
- Schemas, roles and grants are created by a bootstrap migration run with the master secret.

## Verified versions & availability
Checked against primary sources on 2026-10-09. Sources are in `orchestration/verify-claims-01.md`. Re-check before M3.

| Item | Value | Note |
|---|---|---|
| Node.js | **24** (Active LTS) | Node 26 becomes LTS on 2026-10-28; stay on 24 for dev |
| Lambda runtime | **container image on `public.ecr.aws/lambda/nodejs:24`** (ADR-030; managed `nodejs24.x` no longer used) | `nodejs26.x` is preview only. ⚠ af-south-1 availability is UNVERIFIED: first M3 task creates a test function there |
| Aurora PostgreSQL | **18.x** Serverless v2 | Native `uuidv7()` exists in PG 18, so we use it (no app-side UUIDs) |
| Aurora min ACU | 0 + auto-pause supported; budgeted at **0.5** | 24x7 task connections stop it from pausing |
| ECS Fargate ARM64 + Service Connect | available in af-south-1 | Service Connect has no extra charge |
| Cognito | M2M + custom scopes on every plan | ⚠ $0.00225 per token request, no free tier, so tokens must be cached |
| SES | **API only**, SMTP not in af-south-1 | Use `@aws-sdk/client-sesv2`. Sandbox: 200 per day, 1 per second, verified recipients only |
| Terraform / hashicorp/aws | 1.16.5 / **~> 6.68** | local machine has 1.11.3 — upgrade before M3 |
| TypeScript | **6.0.3** (not 7.x) | typescript-eslint 8.72 supports TS < 6.1 (F-01, 2026-10-19) |
| Lambda base image | `public.ecr.aws/lambda/nodejs:24` (arm64) | build with `--provenance=false` |
| GuardDuty Malware Protection for S3 | available in af-south-1 | $0.099/GB + $0.000237/object after the free tier; 100 GB max object size |
| fastify / zod / vitest | 5.12.5 / 4.6.5 / 5.0.3 | zod **4** API |
| @testcontainers/postgresql | 12.2.0 | |
| node-pg-migrate / pino / aws-jwt-verify | 9.0.0 / 10.4.0 / 5.2.1 | |
| pnpm | 12.10.1 | |
| @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | ⚠ UNVERIFIED — add to next /verify-claims | presigned PUT with signed `x-amz-checksum-sha256` (ADR-028) — confirm checksum headers can be signed into a presigned PUT |
| GuardDuty Malware Protection for S3 | ⚠ UNVERIFIED in af-south-1 + pricing | if unavailable: evidence-intake does magic-byte + checksum checks only and flags "not scanned"; owner decides |
| AWS WAF body-size rule | no longer relevant — API bodies are small JSON; files go straight to S3 | |
| LocalStack | ⚠ needs an account + auth token; free Hobby plan is non-commercial; no SES v2 | See Q-11. Default: **moto** server for SQS and S3 locally; SES mocked at the SDK boundary |

Cognito token and JWKS endpoints are public, so tasks and Lambdas need NAT egress (or PrivateLink support, which is unverified).

## Cost estimate (af-south-1, 730 h/month, list prices from the AWS Price List API, 2026-10-09)
| Line | Arithmetic (summary) | $/month |
|---|---|---|
| Fargate ARM64, 4 × (0.25 vCPU, 0.5 GB) | 4 tasks × 730 h × ARM vCPU+GB rate (x86 would be $48.62) | 38.92 |
| ALB + 2 public IPv4 | hourly + 1 LCU assumed + 2 × IPv4 | 36.13 |
| NAT gateway + EIP + 10 GB processed | hourly + IPv4 + per-GB | 45.83 |
| Aurora Serverless v2 @ 0.5 ACU | 0.5 × 730 × ACU-hour | 58.40 |
| Aurora storage 20 GB + I/O | | 5.22 |
| WAF: 1 ACL + common rule group + 1M requests | | 6.60 |
| Secrets Manager ×5 | 5 × $0.41 | 2.05 |
| KMS ×2 | 2 × $1 | 2.00 |
| CloudWatch Logs 5 GB ingest | | 3.57 |
| Cognito M2M ≈ 2,880 token requests (6 clients, ~hourly refresh, cached) | 2,880 × $0.00225 | 6.48 |
| Internal ALB (Lambda → service port 8081, PR-01 F3) | hourly + low LCU, no public IPs — ⚠ unit price not yet verified, est. | ~20 |
| **Total (lower bound)** | | **≈ $225** |

Treat this as a **lower bound**. The reviewer estimates $225–235 once the excluded lines are added. The total falls by about $58 if Aurora really pauses. Not included: data transfer out, ECR storage, custom metrics and free-tier offsets.
**VPC endpoints vs NAT:** about 9 interface endpoints × 2 AZs × $9.56 ≈ $172, against one NAT at about $46. NAT plus the free S3 gateway endpoint wins for dev.
**Cognito cost trap:** an auth-client that skipped caching would request a token per call. At 1M calls that is $2,250. Token caching is an acceptance criterion in S-04.
