# Verify claims 01: af-south-1 card-dispute POC

Date checked: **2026-10-09** (all rows). Primary sources only. Prices are USD, on-demand, af-south-1, taken from the AWS Price List API bulk files (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<svc>/current/af-south-1/index.json`; publication dates 2026-09-11 to 2026-10-09).

## Corrections to watch for

1. **SES SMTP endpoints are NOT available in af-south-1.** The SES API (`email.af-south-1.amazonaws.com`, SDK v2) and inbound receiving work there. Send through `@aws-sdk/client-sesv2`, not nodemailer/SMTP. The sandbox applies per region.
2. **Node.js 26 is NOT LTS yet.** It is scheduled to become LTS on 2026-10-28. Node.js **24 (Krypton)** is the current Active LTS, and it moves to Maintenance on 2026-10-20. Lambda `nodejs26.x` is still in **public preview**, with GA targeted for November 2026. Use **Node 24 / `nodejs24.x`** now.
3. **Aurora Serverless v2 minimum is 0 ACU (auto-pause), but it will not pause in practice.** 4 Fargate tasks running 24x7 hold pooled connections, and any open user connection blocks the pause. Budget at **0.5 ACU**, or close pools when idle. RDS Proxy also blocks the pause.
4. **Aurora PostgreSQL 18 is GA (latest 18.6.1, 2026-10-09) and supports Serverless v2 in af-south-1 (18.3+).** `uuidv7()` is native in PG 18, so the `uuid-ossp`/pg_uuidv7 extension is not needed.
5. **LocalStack has had no anonymous community image since 2026-03-23 (release 2026.03.0).** It now needs an account and `LOCALSTACK_AUTH_TOKEN`, including in CI. The free **Hobby** plan covers S3/SQS/SES (v1 only, **not SES API v2**) and is labelled **non-commercial**. A bank POC probably needs **Base at $39–45/user/month**, or moto / a real AWS sandbox account instead. This matters for testcontainers' LocalStack module too.
6. **Cognito M2M has no free tier for token requests: $0.00225 per token** in af-south-1, and app clients are $0. Tokens must be cached until expiry. Fetching a token on every request would cost about $2,250 per 1M requests.
7. **The "default" library versions are newer than you might expect.** vitest **5**, zod **4**, testcontainers **12**, pino **10**, node-pg-migrate **9**, pnpm **12**, and the hashicorp/aws provider is still **6.x** (no 7.x).
8. **Aurora Serverless platform v4 is NOT offered in af-south-1** (only v1–3). This is a performance-only difference.
9. **VPC endpoints cost more than a single NAT for this POC** (see §12).

## 1–6. Region availability (af-south-1)

| # | Claim | Verdict | Correct value / notes | Source |
|---|---|---|---|---|
| 1 | Cognito user pools in af-south-1; client_credentials + resource-server custom scopes | CONFIRMED | Available. M2M (client credentials) and resource servers with custom scopes are in **all plans (Lite, Essentials, Plus)**. The default plan for new pools is **Essentials**. *Access-token* customisation (pre-token-gen Lambda adding scopes/claims to access tokens) requires **Essentials or Plus**; Lite only allows ID-token customisation. M2M pricing in af-south-1: app clients $0.00; tokens $0.00225 each (0–250k), $0.0015 (250k–5M), $0.001125 (>5M); no free tier. MAU pricing: Lite $0.0055, Essentials $0.015, Plus $0.020, with a 10k MAU free tier for Lite/Essentials (none for Plus). | AWS regional table (api.regional-table.region-services.aws.a2z.com); https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html ; https://aws.amazon.com/cognito/pricing/ ; Price List AmazonCognito af-south-1 |
| 2 | SES available in af-south-1 (sending); sandbox limits | CORRECTED (partial) | The SES **API sending** endpoint exists, as do DKIM (`dkim.af-south-1.amazonses.com`) and inbound receiving. The **SMTP interface is not available** in af-south-1. Sandbox: send only to verified identities or the mailbox simulator; **200 msgs/24h, 1 msg/s**; the sandbox is per region. | https://docs.aws.amazon.com/general/latest/gr/ses.html ; https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html |
| 3 | Aurora PostgreSQL Serverless v2 in af-south-1; min ACU; latest major | CONFIRMED | Available in af-south-1 for APG 13.6+, 14.3+, 15.2+, 16.1+, 17.4+, **18.3+**. **Min 0 ACU (auto-pause)** needs APG **16.3+, 15.7+, 14.12+ or 13.15+** (and any 17.x/18.x supported by Serverless v2). Otherwise the min is 0.5 ACU. The max is 256 ACU. Resume takes ~15 s, or ≥30 s after 24 h paused. Latest Aurora PostgreSQL major: **18** (18.6.1, released 2026-10-09). Platform v4 is not in af-south-1. | https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html ; .../aurora-serverless-v2.how-it-works.html ; .../aurora-serverless-v2-auto-pause.html ; https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Updates.html |
| 4 | ECS Fargate + Service Connect in af-south-1 | CONFIRMED | Fargate Linux is supported in af-south-1. ARM64 Fargate has no af-south-1 exclusion (only use1-az3 is excluded) and is priced in af-south-1. Service Connect: the GA post says it is available in all commercial Regions where ECS is available, except China. The Sept 2025 cross-account post repeats "all commercial AWS Regions". No extra charge. | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate-Regions.html ; .../ecs-arm64.html ; https://aws.amazon.com/blogs/aws/new-amazon-ecs-service-connect-enabling-easy-communication-between-microservices/ ; https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-ecs-service-connect-cross-account-workloads/ |
| 5 | WAF (ALB), Secrets Manager, KMS, SQS, S3, Lambda, ECR, X-Ray in af-south-1 | CONFIRMED | All are listed for af-south-1 in the AWS Regional Services table, together with ELB, NAT Gateway, PrivateLink, CloudWatch Logs and VPC Lattice. All have af-south-1 SKUs in the Price List. The table file's source version is 2025-11-13, so it is slightly stale, but these are long-standing services. | https://api.regional-table.region-services.aws.a2z.com/index.json (backs https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/) |
| 6 | Latest Lambda Node.js runtime; in af-south-1 | CORRECTED / partly UNVERIFIED | The latest **GA** runtime is **`nodejs24.x`** (AL2023, deprecation 2028-04-30). `nodejs26.x` is **public preview** only (no SLA), with GA targeted for Nov 2026. `nodejs22.x` is deprecated 2027-04-30. Lambda runs in af-south-1, and the docs list no regional exceptions for nodejs24.x. Per-region runtime availability is **UNVERIFIED** because AWS publishes no table for it. Confirm with a `CreateFunction` in af-south-1. | https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html |

## 7–11. Versions

| # | Item | Verdict | Value | Source |
|---|---|---|---|---|
| 7 | Node.js Active LTS | CONFIRMED | **v24 "Krypton"** (latest v24.21.0, 2026-09-07). It enters Maintenance on 2026-10-20. **v26** (current v26.11.1) becomes LTS on **2026-10-28**. | https://nodejs.org/dist/index.json ; https://github.com/nodejs/Release (schedule.json) |
| 8 | Terraform CLI / hashicorp/aws provider | CONFIRMED | Terraform **1.16.5** (2026-10-02). hashicorp/aws **6.68.0** (2026-10-07); major **6**, and no 7.x is published. | https://checkpoint-api.hashicorp.com/v1/check/terraform ; https://github.com/hashicorp/terraform/releases ; https://registry.terraform.io/v1/providers/hashicorp/aws/versions |
| 9 | npm latest | CONFIRMED | fastify **5.12.5**; zod **4.6.5**; vitest **5.0.3**; testcontainers **12.2.0**; @testcontainers/postgresql **12.2.0**; node-pg-migrate **9.0.0**; pino **10.4.0**; aws-jwt-verify **5.2.1**; @aws-sdk/client-sqs **3.1148.0**; pnpm **12.10.1** | https://registry.npmjs.org/<pkg>/latest |
| 10 | Native `uuidv7()` | CONFIRMED | Native since **PostgreSQL 18** (`uuidv7([shift interval])`). It is available on Aurora PostgreSQL **18.x**, which is GA (latest 18.6.1) and supports Serverless v2 in af-south-1 from 18.3. It is **not** native in APG ≤17. | https://www.postgresql.org/docs/18/functions-uuid.html ; Aurora PG release notes (above) |
| 11 | LocalStack free edition: SQS/S3/SES | CORRECTED | The community image was retired on **2026-03-23** (release 2026.03.0, single image). An **account + auth token (`LOCALSTACK_AUTH_TOKEN`) is required**, including in CI. The temporary bypass ended on 2026-04-06. The free **Hobby** plan includes S3, SQS and SES v1 (**not SES v2**) and is "for hobbyists & other non-commercial usage". Base costs $39/licence/month (annual) or $45 (monthly). | https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/ ; https://docs.localstack.cloud/aws/licensing/ ; https://localstack.cloud/pricing ; https://docs.localstack.cloud/aws/getting-started/installation/ |

## 12. Monthly cost estimate (af-south-1, 730 h/month)

Unit prices come from the AWS Price List API, af-south-1 files (AmazonECS, AWSELB, AmazonEC2, AmazonVPC, AmazonRDS, awswaf, AWSSecretsManager, awskms, AmazonCloudWatch, AmazonCognito). The WAF managed-rule-group fee is confirmed at https://aws.amazon.com/waf/pricing/.

| Line | Unit prices | Arithmetic | $/mo |
|---|---|---|---|
| Fargate ARM, 4 × (0.25 vCPU, 0.5 GB) | vCPU $0.04372/h; GB $0.0048/h | (0.25×0.04372 + 0.5×0.0048) = $0.01333/h × 730 = 9.73 × 4 | **38.92** |
| *(x86 for comparison)* | vCPU $0.0546/h; GB $0.006/h | 0.01665 × 730 × 4 | *(48.62)*, so ARM saves ~20% |
| ALB | $0.03/h; LCU $0.0095/h | 0.03×730 = 21.90; assumed 1 LCU avg: 0.0095×730 = 6.93 | **28.83** |
| ALB public IPv4 (2 AZ) | $0.005/IP-h | 2 × 0.005 × 730 | **7.30** |
| NAT Gateway (1, single-AZ) | $0.057/h; $0.057/GB | 0.057×730 = 41.61; assumed 10 GB: 0.57 | **42.18** |
| NAT EIP | $0.005/h | 0.005×730 | **3.65** |
| Aurora Serverless v2 compute (Standard) | $0.16/ACU-h (I/O-Opt $0.21) | **min 0.5 ACU** realistic: 0.5×0.16×730. With auto-pause at min 0 it is $0 only while paused, which is unlikely with 24x7 pools. | **58.40** |
| Aurora storage + I/O | $0.131/GB-mo; $0.26/1M I/O | 20×0.131 = 2.62; assumed 10M I/O = 2.60 | **5.22** |
| WAF (1 web ACL + AWSManagedRulesCommonRuleSet) | ACL $5/mo; rule/group $1/mo; $0.60/1M req (≤1500 WCU) | 5 + 1 + assumed 1M req × 0.60 | **6.60** |
| Secrets Manager (5) | $0.40/secret; $0.05/10k API | 5×0.40 + ~10k calls 0.05 | **2.05** |
| KMS (2 CMKs) | $1/key-mo; $0.03/10k req (20k/mo free) | 2×1 | **2.00** |
| CloudWatch Logs (5 GB) | ingest $0.678/GB; store $0.036/GB-mo | 5×0.678 = 3.39; 5×0.036 = 0.18 | **3.57** |
| Cognito (<100 MAU + M2M) | MAU free ≤10k (Lite/Ess.); M2M $0.00225/token | assumed 4 clients × 1 token/h × 720 h = 2,880 × 0.00225 | **6.48** |
| SQS / Lambda / S3 / SES / ECR / X-Ray | not priced | negligible at POC volume | ~0 |
| **TOTAL (realistic, 0.5 ACU always on)** | | | **≈ $205.20/mo** |
| Total if Aurora actually auto-pauses ~100% | | 205.20 − 58.40 | ≈ $146.80/mo |

Excluded: data transfer out to the internet, ECR storage, CloudWatch metrics/alarms, AWS free-tier offsets, tax. Multi-AZ NAT (one per AZ) would add another +$45.83.

### VPC endpoints vs NAT

- An interface endpoint costs **$0.01309/h per AZ = $9.56/mo per endpoint per AZ**, plus $0.01/GB. The S3 **gateway** endpoint is free and worth adding regardless.
- A private Fargate setup with no NAT needs roughly: ecr.api, ecr.dkr, logs, secretsmanager, sqs, kms, email (SES), xray, sts. That is **9 endpoints × 2 AZ × $9.56 ≈ $172/mo**. Placing them in 1 AZ is about $86/mo. Either way it exceeds **1 NAT ≈ $45.83/mo**.
- Cognito `/oauth2/token` and JWKS calls go to the user-pool domain, which is a public endpoint. Whether a PrivateLink endpoint covers that domain is UNVERIFIED (not checked), so assume NAT egress is needed.
- **Recommendation for the POC:** 1 NAT gateway plus the free S3 gateway endpoint. Revisit endpoints only if data-processing volume through NAT becomes large (the NAT charge is $0.057/GB against $0.01/GB for endpoints).
