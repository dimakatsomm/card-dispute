# V-M3 verification: claims M3 depends on

Checked 2026-10-20/21 against primary sources. Prices are USD, af-south-1, from the AWS Price List bulk API
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/af-south-1/index.json`,
publication dates 2026-09-11 to 2026-10-20). Prices change; re-check before any hard budget decision.
The regional-services table (`https://api.regional-table.region-services.aws.a2z.com/index.json`) has source version
20251113, older than the rest, so it is used only as corroboration.

Verdicts: TRUE / FALSE / PARTIAL / UNKNOWN.

## Claim table

| # | Claim | Verdict | Source (checked 2026-10-20/21) | Consequence for the plan |
|---|---|---|---|---|
| 1a | CloudFront VPC origins support an ALB in af-south-1 | TRUE | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html (Supported Regions table lists Africa (Cape Town) af-south-1, no AZ exception) | `edge_origin_mode = vpc_origin`. |
| 1b | Constraints | TRUE (documented) | same page | VPC needs an internet gateway (NAT implies one) and a private subnet with a free IPv4 per origin subnet (service-managed ENI). ALB must be Active before the VPC origin is created; the origin takes up to 15 min to reach Deployed. ALB SG must admit either prefix list `com.amazonaws.global.cloudfront.origin-facing` or the service-managed SG `CloudFront-VPCOrigins-Service-SG` (exists only after the VPC origin is created; never create an SG with that name prefix). Unsupported: gRPC, Lambda@Edge origin request/response triggers (plan uses a CloudFront Function, fine), inbound NACL evaluation (outbound ephemeral 1024-65535 must be allowed). I-02/I-07/I-08 must order: ALB, then VPC origin, then ALB ingress rule from the service SG. The prefix list works before the origin exists but admits every CloudFront tenant, so use it only as a bootstrap step. Terraform `aws_cloudfront_vpc_origin` with `vpc_origin_endpoint_config` (arn, http_port, https_port, origin_protocol_policy, origin_ssl_protocols) exists (https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/website/docs/r/cloudfront_vpc_origin.html.markdown); `http-only` on :80 fits ADR-059. How Terraform resolves the service SG id: UNKNOWN (no primary source); settle at first apply. |
| 1c | VPC origin pricing | TRUE: no separate charge on pay-as-you-go | https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ (origin fetches free, including origins in private subnets through VPC origins); no VPC SKU in the CloudFront price list JSON; ENI addresses carry no cost (VPC origins doc) | No CloudFront line item for the VPC origin. |
| 1d | CloudFront flat-rate plans exist and bundle WAF | TRUE | https://aws.amazon.com/cloudfront/pricing/ and https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html | Free $0 (5 WAF rules, 16 KB body inspection), Pro $15 (25 rules), Business $200 (50 rules), Premium $1,000. Plans include web ACL, rules and WAF request fees. **Private VPC origins are Business and above only**; Business equals the whole budget. Free/Pro would save about $9 (CloudFront + WAF) but force `public_alb` (public IPv4 for the ALB about $7/month, secret-header exposure) and cap body inspection at 16 KB. Account must not be on AWS Free Tier to subscribe. Net: stay on pay-as-you-go. |
| 2a | Cognito M2M price per token request | TRUE: $0.00225 (0-250k/month), $0.0015 (250k-5M), $0.001125 (>5M); no free tier | https://aws.amazon.com/cognito/pricing/ ; price list `AFS1-CUPM2MTokenRequestsFull` (af-south-1) | Cost scales with token fetches, not clients. |
| 2b | Per-app-client monthly fee | FALSE (removed 2025-11-03) | https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-cognito-removes-machine-machine-app-client-price-dimension ; price list `AFS1-CUPM2MAppClients*` = $0.00 in all tiers | Delete the "+$30 if Cognito charges per M2M client" contingency. |
| 2c | Lite/Essentials tier affects M2M | FALSE | pricing page lists M2M as an add-on for Lite, Essentials and Plus alike, one rate | None. User MAU: first 10,000 free (`Global-CognitoFreeTierMAU`). |
| 2d | af-south-1 pricing differs | FALSE for M2M (same $0.00225); user MAU rates differ slightly | price list af-south-1 | None. |
| 2e | (derived) Token validity drives M2M cost | TRUE (cost risk) | `backend/packages/auth-client/src/service-token.ts` refreshes lazily at expiry minus a margin; docs/05 and I-03 say access tokens 15 min | At 15 min a busy caller costs about $6.6/month (about 2,920 tokens); at 1 h about $1.6. **Set `access_token_validity` on the svc-* clients to 60 min** (per-client); spa keeps 15 min. |
| 3a | Lambda container-image functions on arm64 in af-south-1 | PARTIAL | https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html (all supported runtimes support both x86_64 and arm64; nodejs24.x supported); price list has af-south-1 arm SKUs (`AFS1-Lambda-GB-Second-ARM`, `AFS1-Request-ARM`); Lambda and ECR listed for af-south-1 in the regional table | arm64 in af-south-1 is TRUE. No exclusion for the container-image package type found, but no source states it for af-south-1. Phase B [P] proves it. |
| 3b | EventBridge Scheduler in af-south-1 | PARTIAL (strong evidence) | price list `AWSEvents` af-south-1 has `AFS1-ScheduledInvocation` ($0 first 14M, then $1.35/M); regional table lists Amazon EventBridge. The General Reference endpoint page could not be fetched | Treat as available. Settle with `aws scheduler list-schedule-groups --region af-south-1` in OWN-1. |
| 3c | `ReportBatchItemFailures` on the SQS event source mapping | TRUE | https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html | Response must be a `batchItemFailures` list of `itemIdentifier`; null/empty/unknown id fails the whole batch. |
| 4a | Aurora PostgreSQL 18 Serverless v2 in af-south-1 | TRUE (18.3 and higher) | https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html ; What's New: PG18 GA 2026-06-11, 18.4 on 2026-08-24 | OWN-1 orderable check still worthwhile. |
| 4b | Minimum ACU | PARTIAL | https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.how-it-works.html : 0.5 floor generally; 0 ACU (auto-pause) needs PG 16.3+ (table does not list 17/18). Platform v4 is not in af-south-1 (v3 is) | 0.5 ACU is safe. 0 ACU on PG18 likely but unconfirmed; expose `aurora_min_acu` variable (default 0.5). |
| 4c | Price per ACU-hour | TRUE: $0.16 (Standard), $0.21 (I/O-Optimized); storage $0.131/GB-month; I/O $0.26 per million; backup $0.025/GB beyond free | price list `AmazonRDS` af-south-1 | 0.5 ACU x 730 h = $58.40. |
| 5a | Cognito prefix domain in af-south-1 | TRUE (no exclusion documented; Cognito listed for af-south-1) | https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain-prefix.html | Format `https://<prefix>.auth.af-south-1.amazoncognito.com`. Docs note the openid-configuration discovery document is served on the custom domain only: take issuer/JWKS from `https://cognito-idp.af-south-1.amazonaws.com/<poolId>` (not fetched here; confirm in V-09). |
| 5b | Token endpoint | TRUE | https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html | `POST https://<prefix>.auth.af-south-1.amazoncognito.com/oauth2/token`, form-encoded, `client_secret_basic` or `client_secret_post`; client needs a secret and `client_credentials` in AllowedOAuthFlows; returns an access token only. |
| 6a | SESv2 in af-south-1; identity verification in sandbox | TRUE | https://docs.aws.amazon.com/general/latest/gr/ses.html (API `email.af-south-1.amazonaws.com`; SMTP not available there, as the constitution says); https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html | Sandbox needs sender and every recipient verified; quota 200/24 h, 1/s. Owner address as both is fine. |
| 6b | Config-set event destination to EventBridge | PARTIAL | https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-eventbridge.html ; https://docs.aws.amazon.com/ses/latest/dg/monitoring-eventbridge.html | Supported, **default event bus only**; events `source=aws.ses`, `detail-type` like `Email Delivered`; best-effort, may be out of order. No regional restriction found; none stated for af-south-1. I-12 rule must sit on the default bus. Confirm at first apply. |
| 7a | GuardDuty Malware Protection for S3 in af-south-1 | TRUE | price list `AmazonGuardDuty` af-south-1 has `AFS1-MalwareProtectionS3*` SKUs; GuardDuty and S3 listed for af-south-1; https://aws.amazon.com/about-aws/whats-new/2024/06/detect-malware-object-uploads-amazon-s3-guardduty (all GuardDuty Regions except China/GovCloud at launch); https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_regions.html lists no S3 malware exclusion for af-south-1 | ADR-042 holds. |
| 7b | Pricing | TRUE: $0.099 per GB scanned (first 1 GB/month free), $0.000237 per object (first 1,000/month free) | price list af-south-1 | Negligible at dev volume. |
| 8a | Fargate On-Demand vCPU default, new account | TRUE: 6 vCPU (adjustable); new accounts may start lower and rise with usage | https://docs.aws.amazon.com/general/latest/gr/ecs-service.html | 5 x 0.25 = 1.25 vCPU plus one-shot tasks and rolling deploys (about 2.5 peak) fits. af-south-1 launch rate 5 tasks/s sustained, 25 burst. Keep the OWN-1 check at >=3. |
| 8b | Lambda concurrent executions default, new account | PARTIAL | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html : default 1,000, but new accounts have reduced concurrency; starting value not stated | Exact number UNKNOWN; settle with `aws lambda get-account-settings`. Plan already avoids reserved concurrency. |
| 9 | Service Connect + `serviceRegistries` together | N/A | item 1 is positive; not researched | Cloud Map fallback not needed. |
| 10a | GitHub OIDC `sub`, branch push | TRUE: `repo:OWNER/REPO:ref:refs/heads/main` (only when the job references no environment) | https://docs.github.com/en/actions/reference/security/oidc | I-00 plan-role trust OK. |
| 10b | GitHub OIDC `sub`, environment job | TRUE: `repo:OWNER/REPO:environment:dev` | same | I-00 apply-role trust OK. |
| 10c | Can a pull_request job present those subs | PARTIAL, with a gap | OIDC page: a PR job without environment presents `repo:OWNER/REPO:pull_request`; **a PR job that references `environment: dev` presents the environment sub instead**. https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments : a `main`-only deployment branch rule does not match a pull_request run unless `refs/pull/*/merge` is added | A PR job can never present the `refs/heads/main` sub. It can present the environment sub only if the Environment admits PR refs. OWN-3 must keep deployment branches = `main` only (never add `refs/pull/*/merge`) plus the required reviewer. Fork-PR token behaviour not verified here. The `oidc-negative` PR job (no environment) expecting AccessDenied is consistent with this. |
| 11 | Cost table numbers | see below | | |

## Item 11: verified unit prices (af-south-1)

| Item | Verified | Source |
|---|---|---|
| NAT gateway hour | $0.057/h = $41.61/month | EC2 price list `AFS1-NatGateway-Hours` |
| NAT data processing | $0.057/GB | `AFS1-NatGateway-Bytes` |
| Public IPv4 (NAT EIP) | $0.005/h = $3.65/month | VPC price list |
| ALB hour | $0.03/h = $21.90/month | ELB price list |
| ALB LCU | $0.0095 per LCU-hour (about $6.94 per sustained LCU) | ELB price list |
| Fargate ARM vCPU | $0.04372 per vCPU-hour | ECS price list |
| Fargate ARM memory | $0.0048 per GB-hour | ECS price list |
| Secrets Manager | $0.40 per secret-month, $0.05 per 10k calls | Secrets price list |
| KMS | $1 per key-month, $0.03 per 10k requests, 20k free | KMS price list |
| WAF | web ACL $5, rule $1 each, $0.60 per million requests (CloudFront WAF bills at global rates; af-south-1 file shows the same numbers) | WAF price list |
| CloudWatch | logs ingest $0.678/GB, storage $0.036/GB-month, alarm $0.10 | CloudWatch price list |
| CloudFront (South Africa edge) | HTTPS $0.012 per 10k, egress $0.11/GB after free 1 TB and 10M requests; Functions $0.10 per million after 2M free | CloudFront price list |
| Aurora PG Serverless v2 | $0.16 per ACU-hour | see 4c |

### Corrected monthly estimate (24x7, planned layout, one task per service)

Assumptions: Service Connect proxy fits inside 0.25 vCPU / 0.5 GB tasks (risk R1); svc token validity 1 h; about 20 GB NAT traffic; WAF = web ACL + 3 rules; 19 secrets (5 svc client + 9 role + 1 master + 4 seed users); 3 KMS keys (state, cd-data, cd-evidence).

| Line | Plan | Corrected | Note |
|---|---|---|---|
| Aurora 0.5 ACU | 64 | 63 | 58.40 compute + about 0.7 storage + about 4 I/O |
| NAT gateway + EIP + data | 46 | 46 | 41.61 + 3.65 + about 1 |
| Fargate 5 x 0.25 vCPU / 0.5 GB ARM | 50 | 49 | 5 x $9.73 |
| Internal ALB | 22 | 25 | 21.90 + light LCU |
| CloudFront | 3 | 0.5 | inside always-free 1 TB / 10M requests |
| WAF | 7 | 9 | $5 + 3 rules + requests |
| Cognito M2M | 6.5 | 7 | valid at 1 h validity; 15 min gives about 21-25 |
| Secrets Manager | 6 | 7.6 | 19 secrets |
| KMS | 3 | 3.3 | |
| CloudWatch | 6 | 6.5 | |
| Other (ECR, S3, SQS, SES, GuardDuty, Scheduler, Reachability Analyzer) | 7 | 5 | |
| **Total** | **about 220** | **about 222 (range 210-235)** | |

Scenarios (delta to the 222 baseline):

| Scenario | Delta | Total |
|---|---|---|
| R1: Service Connect proxy forces 0.5 vCPU / 1 GB on the 4 Service Connect services | +39 | about 261 |
| R2: svc clients left at 15 min token validity | +14 to +20 | about 238 |
| `public_alb` fallback (not needed) | +7 | about 229 |
| Per-client Cognito fee | 0 (removed) | the "+30" contingency is deleted |
| Park lever: services at desired_count 0 for about 60% of hours | about -29 | about 193 |
| Park lever: Aurora min ACU 0 (if PG18 supports it) | up to -55 when idle | about 170-205 |

Next tier: a second task per service adds about $49 Fargate; Aurora at 2 ACU adds up to $175; NAT, ALB and WAF stay about flat.

Budget: owner budget $200. Running 24x7 is about $222, roughly $22 (11%) over. The forecast-100% alert fires in week one and actual-80% ($160) at about day 22; ADR-063 already expects this. Reaching $200 needs a park procedure (desired_count 0 and/or Aurora auto-pause) or accepting about $225.

## Risks found

- R1 (cost, PARTIAL): AWS recommends adding 256 CPU units and at least 64 MiB for the Service Connect proxy (https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-concepts-deploy.html). The 0.25 vCPU / 0.5 GB tasks have no headroom by that guidance. Test under net-probe/e2e load; resize only services that throttle. Largest cost uncertainty.
- R2 (cost): M2M token validity, see 2e.
- R3 (security): environment-sub trust depends on Environment deployment-branch rules, see 10c.
- R4 (ordering): VPC origin service SG exists only after the origin, see 1b.

## Decisions

- **edge_origin_mode = `vpc_origin`.** Supported in af-south-1 for an ALB, no extra charge on pay-as-you-go. Do not use flat-rate plans: VPC origins need Business ($200).
- **Cognito per-client fee: does not apply** (removed 2025-11-03). Only $0.00225 per token request applies; set svc client access-token validity to 60 min.
- **Unavailable planned components in af-south-1: none found.** Confirmed: CloudFront VPC origins, Aurora PG18 Serverless v2, SESv2 API, GuardDuty S3 malware protection, Cognito. Residual checks at OWN-1/first apply: container-image Lambdas on arm64, EventBridge Scheduler, SES to EventBridge, Aurora PG18 0-ACU, Lambda new-account concurrency value.
- **Corrected cost: about $222/month (range $210-235) vs the $200 budget, about $22 over** at 24x7; about $261 if R1 bites; under $200 only with the park levers. The earlier $220 total was right in sum but wrong in parts (CloudFront and "other" lower; ALB, WAF, secrets higher).
