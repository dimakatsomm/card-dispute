# Terraform modules — interface contract (M3)

This file is the contract between the wave-1 module tasks (I-00 … I-15) and I-WIRE. A module implements
**exactly** the inputs and outputs listed here, with these names and types. Change this file first (via the
orchestrator) if a name or type must change; never diverge silently.

Root: `infra/terraform/envs/dev` (providers, backend, variables owned by I-ENV; `main.tf`, `workloads.tf`,
`outputs.tf` owned by I-WIRE). `infra/terraform/bootstrap` is a separate root with its own state.

## 1. Conventions

### Naming
| Thing | Pattern | Example |
|---|---|---|
| Resource name | `${name_prefix}-<component>` | `cd-disputes`, `cd-dispute-notifications` |
| Globally unique name (S3) | `${name_prefix}-dev-<component>-<account-id>` (account id from `data.aws_caller_identity`, never typed) | `cd-dev-quarantine-<acct>` |
| Secrets Manager | `${name_prefix}/dev/<area>/<name>` | `cd/dev/db/disputes_app`, `cd/dev/cognito/svc-disputes` |
| IAM role | name `${name_prefix}-<component>-<kind>`, path `/${name_prefix}/`, permissions boundary `${name_prefix}-workload-boundary` | `/cd/cd-disputes-task` |
| KMS alias | `alias/${name_prefix}-<key>` | `alias/cd-data` |
| ECS log group | `/${name_prefix}/dev/ecs/<service>` | `/cd/dev/ecs/users` |
| Lambda log group | `/aws/lambda/${name_prefix}-<function-key>` | `/aws/lambda/cd-dispute-notifier` |
| Tool log group | `/${name_prefix}/dev/tools/<task>` | `/cd/dev/tools/db-bootstrap` |

`name_prefix` is `cd`. The bootstrap apply role (I-00) is scoped to these patterns: `cd-*`, `cd/*` (secrets),
`/cd/*` (log groups), `alias/cd-*`, role path `/cd/`, namespace `cd.internal`, buckets `cd-dev-*`.

### Tags
Tags come from `default_tags` on both providers in `envs/dev/providers.tf` (`project`, `environment=dev`,
`managed-by=terraform`, `repo`). Modules do not set those tags; they may add `component = "<module dir>"`.

### Module shape
- Files: `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, `tests/*.tftest.hcl`. No `provider` blocks in modules.
- `versions.tf`: `required_version = ">= 1.10"`, `hashicorp/aws` `">= 6.67, < 7.0"` (plus `hashicorp/random` if used).
  `edge` declares `configuration_aliases = [aws.us_east_1]`.
- Every variable and output has a `description`; inputs with a closed set of values have a `validation`.
- Region is never an input: modules use `data.aws_region.current` / `data.aws_caller_identity.current` /
  `data.aws_partition.current` to build ARNs.
- **Conditionals use plan-known values only** (`bool` inputs, `var.edge_origin_mode`, keys of `lambda_image_uris`).
  Never `count = var.some_arn == null ? 0 : 1` on an ARN that is computed during the same apply.
- Map outputs use the fixed keys in §2 so consumers can index them literally.
- Keep roles and their policies as separate resources (`aws_iam_role` + `aws_iam_role_policy`), and resource
  policies separate from the resource (`aws_sqs_queue_policy`, `aws_s3_bucket_policy`). That keeps the
  cross-module references below free of cycles.
- Secrets are generated (`random_password`) into Secrets Manager, encrypted with `cd-data`. A secret value is
  never a root output. The only secret passed between modules is `alb.origin_secret_header_value`
  (`sensitive = true`, fallback mode only, consumed only by `edge`).

### IAM
- Policy documents are HCL objects in `locals` rendered with `jsonencode(...)`. Do **not** use
  `data "aws_iam_policy_document"`: under `mock_provider` its `json` is a random string, so tests cannot assert
  on it. Tests assert with `jsondecode(<resource>.policy).Statement`.
- Every statement has a `Sid`. Actions and resources are listed explicitly.
- **No `"*"` and no `service:*` in `Action`; no `"*"` in `Resource`**, except the cases below. Each exception
  carries a one-line inline comment naming the AWS reason, and a `Condition` where one exists.

| Exception | Where | Why |
|---|---|---|
| `Resource = "*"` in a KMS **key policy** | security | In a key policy `*` means "this key". Statements still list explicit actions (no `kms:*`, also for the account-root admin statement). |
| `ecr:GetAuthorizationToken` on `*` | ecs-service exec roles, dev-tools, lambda-fn (if needed), ci-roles publish | Action has no resource-level permission. |
| `ecs:RegisterTaskDefinition`, `ecs:DescribeTaskDefinition` on `*` | ci-roles deploy, run-tools | No resource-level permission. |
| `ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface`, `ec2:AssignPrivateIpAddresses`, `ec2:UnassignPrivateIpAddresses` on `*` | lambda-fn (VPC functions) | Lambda VPC ENI management; condition on `ec2:Vpc`/`ec2:Subnet` where supported. |
| `cloudwatch:PutMetricData` on `*` | only if a function/service calls it directly (EMF via logs needs none) | No resource-level permission; condition `cloudwatch:namespace`. |
| `ec2:Describe*` style read actions, `ec2:CreateNetworkInsightsPath`, `ec2:StartNetworkInsightsAnalysis` on `*` | ci-roles `e2e` (Reachability Analyzer, read-only listings) | No resource-level permission for Describe; enumerate actions, no `ec2:*`. |
| `cognito-idp:AdminInitiateAuth` scoped to the pool ARN | ci-roles `e2e` | Not an exception: listed to stress it is pool-scoped. |
| `arn:…:secret:cd/dev/seed-users/*` | dev-tools dev-seed, ci-roles e2e | Partial wildcard: secrets are created at run time by dev-seed. |

- Bucket/queue policies may use `Principal = "*"` only in `Deny` statements (TLS-only, tag deny, non-KMS deny).

### Tests
Every module ships `tests/*.tftest.hcl` that runs offline with `terraform test`:
- `mock_provider "aws" {}` (edge also `mock_provider "aws" { alias = "us_east_1" }`); `mock_provider "random" {}` if used.
- Give ARN-typed attributes realistic mock defaults where the provider validates them, e.g.
  `mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000" } }`.
  `123456789012` is the AWS documentation account id and appears only in tests.
- Assert the module's acceptance criteria from `orchestration/backlog.md` (policy statements, rules, flags), not
  provider behaviour.

## 2. Fixed keys and values

| Name | Values |
|---|---|
| ECS service keys | `auth`, `users`, `transactions`, `disputes`, `web` |
| Lambda keys | `evidence-intake`, `dispute-notifier`, `retention-sweeper` |
| Tool task keys | `db-bootstrap`, `dev-seed`, `net-probe` |
| ECR repo keys | `svc-auth`, `svc-users`, `svc-transactions`, `svc-disputes`, `web`, `lambda-evidence-intake`, `lambda-dispute-notifier`, `lambda-retention-sweeper`, `dev-tools` |
| DB role keys | `auth_migrator`, `auth_app`, `users_migrator`, `users_app`, `transactions_migrator`, `transactions_app`, `disputes_migrator`, `disputes_app`, `disputes_retention` (= `backend/packages/db/bootstrap` ROLES) |
| Cognito service client keys | keys of `modules/cognito/grants.json` (I-03: `svc-users`, `svc-transactions`, `svc-disputes`, `svc-notifier`, `svc-evidence-intake`; I-03t keeps it equal to mock-issuer `SERVICE_GRANTS`) |
| Security group keys | `alb`, `auth`, `users`, `transactions`, `disputes`, `web`, `evidence-intake`, `dispute-notifier`, `retention-sweeper`, `aurora`, `dev-tools` |
| KMS key keys | `data` (Aurora, Secrets Manager, SQS, logs, SNS, ECR), `evidence` (quarantine + evidence buckets) |
| ALB target group keys | `web-8080`, `users-8080`, `transactions-8080`, `disputes-8080`; `users-8081`, `disputes-8081` only when `edge_origin_mode = "vpc_origin"` |
| DLQ keys | `notifications`, `evidence-intake`, `retention-scheduler` |
| Ports | public `8080`, service `8081` (web: `8080` only); Aurora `5432` |
| Health | `/ready` (backend services), `/healthz` (web); 8081 target groups health-check on port `8080` |
| Service Connect | namespace `cd.internal`; discovery names = service keys, so peers use `http://<service>:8081` |
| Lambda alias | `live` |
| Edge headers | `x-cd-route` (`api` on the API origin, `web` on the web origin; origin custom headers override viewer values), `x-cd-origin-secret` (public_alb only) |
| EMF namespaces | `cd/disputes`, `cd/evidence-intake`, `cd/retention-sweeper` |
| SPA paths | callback `/callback`, post-logout `/`, API base `/api` |

## 3. Security group matrix (security module owns every rule except ALB `:80`)

| SG | Ingress | Egress |
|---|---|---|
| `alb` | `:80` from CloudFront (**rule owned by `edge`**, see edge row); `:8081` from `evidence-intake`, `dispute-notifier` | `:8080` to `users`, `transactions`, `disputes`, `web`; `:8081` to `users`, `disputes` |
| `auth` | `:8081` from `users`, `transactions`, `disputes` | `:443` to `0.0.0.0/0` (NAT: Cognito JWKS, Secrets Manager, ECR, Logs); `:5432` to `aurora` |
| `users` | `:8080` from `alb`; `:8081` from `alb`, `transactions`, `disputes` | `:443` any; `:5432` `aurora`; `:8081` `auth` |
| `transactions` | `:8080` from `alb`; `:8081` from `disputes` | `:443` any; `:5432` `aurora`; `:8081` `auth`, `users`, `disputes` |
| `disputes` | `:8080` from `alb`; `:8081` from `alb`, `transactions` | `:443` any; `:5432` `aurora`; `:8081` `auth`, `users`, `transactions` |
| `web` | `:8080` from `alb` | `:443` any (ECR pull, Logs) |
| `evidence-intake`, `dispute-notifier` | none | `:443` any; `:8081` to `alb` (vpc_origin) or to `users`/`disputes` (public_alb, Cloud Map) |
| `retention-sweeper` | none | `:443` any; `:5432` `aurora` |
| `dev-tools` | none | `:443` any; `:5432` `aurora`; `:80`/`:8081` to `alb` and `:8080`/`:8081` to services are **not** granted (net-probe proves the denials) |
| `aurora` | `:5432` from `auth`, `users`, `transactions`, `disputes`, `retention-sweeper`, `dev-tools` | none |

In `public_alb` mode the ALB has no `:8081` rules; instead `users` and `disputes` get `:8081` ingress from
`evidence-intake` and `dispute-notifier` (Cloud Map path, ADR-059 fallback).
No ingress rule anywhere uses a CIDR; `:8081` ingress is always an SG reference. `:443` egress to `0.0.0.0/0`
is required because there are no interface endpoints (NAT decision, docs/06).

## 4. Interface table

Common inputs, listed once: every module takes `name_prefix: string`. Modules that create IAM roles also take
`permissions_boundary_arn: string` and `iam_path: string`. Modules that create log groups also take
`log_retention_days: number` and `logs_kms_key_arn: string`.
`<stmt>` below is
`list(object({ Sid = string, Effect = string, Action = list(string), Resource = list(string), Condition = optional(any) }))`.
`<secret_ref>` is `map(object({ secret_arn = string, json_key = optional(string) }))` (env var name → secret;
ECS renders `valueFrom = "<arn>:<json_key>::"`).

| Module dir | Purpose | Inputs (name: type) | Outputs (name: meaning) | Consumed by |
|---|---|---|---|---|
| `bootstrap` (root, `infra/terraform/bootstrap`) | State bucket (versioned, KMS, TLS-only, BPA, prevent_destroy), GitHub OIDC provider, `gha-infra-plan` / `gha-infra-apply`, permissions boundary. Applied once by the owner (OWN-4). | `github_repo: string`<br>`name_prefix: string` (default `"cd"`) | `state_bucket_name`: bucket for `-backend-config` and `plans/<sha>`<br>`state_kms_key_arn`: state/plan encryption key<br>`github_oidc_provider_arn`: provider for `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`<br>`infra_plan_role_arn`: sub `repo:<repo>:ref:refs/heads/main`<br>`infra_apply_role_arn`: sub `repo:<repo>:environment:dev`<br>`permissions_boundary_arn`: policy `cd-workload-boundary` | No remote state. `envs/dev` backend config (bucket); GitHub Environment vars (role ARNs, bucket). I-WIRE rebuilds the OIDC provider ARN and boundary ARN from the fixed names + `aws_caller_identity` and passes them to `ci-roles` and every role-creating module. |
| `network` | VPC, 2 AZs, public + private subnets, 1 NAT gateway, S3 gateway endpoint, no interface endpoints. | `vpc_cidr: string`<br>`az_count: number` (default 2) | `vpc_id`: VPC id<br>`vpc_cidr`: CIDR<br>`public_subnet_ids: list(string)`: NAT, public ALB (fallback)<br>`private_subnet_ids: list(string)`: ECS, Aurora, Lambdas, internal ALB<br>`private_route_table_ids: list(string)`: default route via NAT<br>`s3_prefix_list_id`: S3 gateway prefix list<br>`nat_public_ip`: NAT EIP | security (`vpc_id`, `s3_prefix_list_id`); ecs-cluster (`vpc_id`); alb (`vpc_id`, both subnet lists); aurora, ecs-service, lambda-fn, dev-tools (`private_subnet_ids`) |
| `security` | KMS keys `cd-data`, `cd-evidence` (rotation on; key policy: explicit admin actions for account root, service principals `logs.af-south-1.amazonaws.com`, `events.amazonaws.com`, `cloudwatch.amazonaws.com` on `data` with `aws:SourceAccount`); every SG and every rule in §3 except ALB `:80`. | `vpc_id: string`<br>`s3_prefix_list_id: string`<br>`edge_origin_mode: string` | `kms_key_arns: map(string)`: keys `data`, `evidence`<br>`security_group_ids: map(string)`: keys in §2 | **all** modules: aurora (`aurora` SG, `data`); ecs-service (own SG, `data`); lambda-fn (own SG, `data`); dev-tools (`dev-tools` SG, `data`); alb (`alb` SG, `data`); edge (`alb` SG id); messaging, ses, observability, cognito, ecr (`data`); evidence-buckets (`evidence`); disputes task statements (`evidence` for `kms:GenerateDataKey`, no Decrypt) |
| `cognito` | User pool (admin-create-only, access 15 min, refresh 1 day), prefix domain, resource servers `auth{validate}`, `users{cards.read,contact.read}`, `transactions{read}`, `disputes{read,evidence.write}`; `spa` client (code + PKCE, `openid`); one client_credentials client per `grants.json` key; optional `e2e` client (`ALLOW_ADMIN_USER_PASSWORD_AUTH` only); client secrets as raw-string secrets `cd/dev/cognito/<client>`. Reads `${path.module}/grants.json` = `{ "<client>": ["<rs>/<scope>", …] }` (single source of grants). | `callback_urls: list(string)`<br>`logout_urls: list(string)`<br>`enable_e2e_client: bool`<br>`secrets_kms_key_arn: string` | `user_pool_id`: pool id<br>`user_pool_arn`: pool ARN<br>`issuer_url`: `https://cognito-idp.af-south-1.amazonaws.com/<pool-id>`<br>`jwks_url`: `<issuer_url>/.well-known/jwks.json`<br>`hosted_ui_base_url`: `https://<prefix>.auth.af-south-1.amazoncognito.com`<br>`token_url`: `<hosted_ui_base_url>/oauth2/token`<br>`spa_client_id`: SPA client id<br>`e2e_client_id`: id or `null`<br>`user_client_ids: list(string)`: spa (+ e2e)<br>`service_client_ids: map(string)`: client key → id<br>`service_client_secret_arns: map(string)`: client key → secret ARN | ecs-service `auth` (`issuer_url`→`AUTH_ISSUER_URL`, `jwks_url`→`AUTH_JWKS_URI`, `user_client_ids`→`AUTH_USER_CLIENT_IDS`, `values(service_client_ids)`→`AUTH_SERVICE_CLIENT_IDS`, comma-joined); `users`/`transactions`/`disputes` (`token_url`→`TOKEN_URL`, `service_client_ids["svc-<svc>"]`→`SERVICE_CLIENT_ID`, secret→`SERVICE_CLIENT_SECRET`); `web` (`issuer_url`→`OIDC_ISSUER`, `spa_client_id`→`OIDC_CLIENT_ID`, `hosted_ui_base_url`→`OIDC_TOKEN_ORIGIN`, `<hosted_ui_base_url>/logout`→`OIDC_LOGOUT_URL`); lambda-fn intake/notifier (`token_url`, client id, secret ARN); dev-tools (`user_pool_arn`, `user_pool_id`); ci-roles (`user_pool_arn`, `e2e_client_id`) |
| `aurora` | Aurora PostgreSQL 18 Serverless v2, 1 writer, DB `disputes`, private subnet group, `rds.force_ssl=1`, RDS-managed master secret (KMS `data`), log export, 7-day backups; nine role secrets `cd/dev/db/<role>` JSON `{username,password,host,port,dbname,url}` with `url` `postgres://…?sslmode=verify-full`; `disputes_retention` adds `engine` (RDS format). No rotation (deferred). | `subnet_ids: list(string)`<br>`security_group_id: string`<br>`kms_key_arn: string`<br>`min_acu: number`<br>`max_acu: number`<br>`deletion_protection: bool`<br>`database_name: string` (default `"disputes"`)<br>`backup_retention_days: number` (default 7) | `cluster_arn`: cluster ARN<br>`cluster_identifier`: for alarms<br>`endpoint`: writer hostname<br>`port: number`: 5432<br>`database_name`: `disputes`<br>`master_secret_arn`: RDS-managed `{username,password}` only<br>`role_secret_arns: map(string)`: DB role key → secret ARN | ecs-service (`role_secret_arns["<svc>_app"]` key `url`→`DATABASE_URL`; `["<svc>_migrator"]` key `url`→`MIGRATOR_DATABASE_URL` on the migrate task); lambda-fn sweeper (`role_secret_arns["disputes_retention"]`→`DATABASE_SECRET_ID`); dev-tools (`master_secret_arn` keys `username`/`password` + `endpoint`/`port`/`database_name` → `DB_ADMIN_*`, role secrets key `password` → `DB_PASSWORD_<ROLE>`, migrator `url` for seed); observability (`cluster_identifier`) |
| `ecr` | Nine repos `cd-<repo key>`: immutable tags, scan on push, keep last 10, KMS. | `repository_keys: list(string)` (default the nine keys)<br>`kms_key_arn: string`<br>`keep_images: number` (default 10) | `repository_urls: map(string)`: repo key → `<acct>.dkr.ecr.af-south-1.amazonaws.com/cd-<key>`<br>`repository_arns: map(string)`<br>`repository_names: map(string)` | ecs-service (`image_uri = "${repository_urls[k]}:initial"`, never pulled at desired 0); dev-tools (`repository_urls["dev-tools"]`); ci-roles (`repository_arns`) |
| `ecs-cluster` | Cluster (Container Insights off) and Cloud Map **private DNS** namespace `cd.internal` (Service Connect default; also serves fallback DNS registration). | `vpc_id: string` | `cluster_arn`<br>`cluster_name`<br>`namespace_arn`: `cd.internal`<br>`namespace_id`<br>`namespace_name`: `cd.internal` | ecs-service (`cluster_arn`, `namespace_arn`, `namespace_id`); dev-tools (`cluster_arn`); ci-roles (`cluster_arn`) |
| `ecs-service` (×5) | One Fargate service + task def (ARM64, 0.25 vCPU / 0.5 GB, non-root, read-only root + `/tmp` volume), desired 0 with `ignore_changes = [task_definition, desired_count]`, circuit breaker + rollback, Service Connect server `<svc>:8081` (backend services), ALB attachments, optional autoscaling 1–2 @ 60 % CPU, task role, execution role (reads only the listed secrets), optional migrate task def `cd-<svc>-migrate`, log group. | `service_name: string` (service key)<br>`cluster_arn: string`<br>`namespace_arn: string`<br>`namespace_id: string`<br>`image_uri: string`<br>`subnet_ids: list(string)`<br>`security_group_id: string`<br>`cpu: number` (256)<br>`memory: number` (512)<br>`service_connect_server: bool`<br>`register_cloud_map_service: bool` (public_alb fallback, users + disputes)<br>`target_groups: map(object({ arn = string, container_port = number }))` (keys `"8080"`, `"8081"`)<br>`health_check_path: string`<br>`environment: map(string)`<br>`secrets: <secret_ref>`<br>`migrate: object({ command = list(string), environment = map(string), secrets = <secret_ref> })` (default `null`, plan-known)<br>`task_role_statements: <stmt>` (default `[]`)<br>`data_kms_key_arn: string`<br>`enable_autoscaling: bool` | `service_name`: `cd-<svc>`<br>`service_arn`<br>`task_definition_family`: `cd-<svc>`<br>`migrate_task_definition_family`: `cd-<svc>-migrate` or `null`<br>`task_role_arn`<br>`task_role_name`<br>`execution_role_arn`<br>`log_group_name`: `/cd/dev/ecs/<svc>` | ci-roles (`service_arn`, both families, `task_role_arn` + `execution_role_arn` for PassRole); messaging (`disputes` `task_role_arn` → `allowed_sender_role_arns`) |
| `edge` | CloudFront distribution (default cert, TLSv1.2_2021): origins `alb-api` (custom header `x-cd-route: api`, + `x-cd-origin-secret` in public_alb) and `alb-web` (`x-cd-route: web`) on the same ALB; `/api/*` → Function strips `/api`, no cache, forwards `Authorization`, `If-Match`, `x-correlation-id`; `/*` static caching (`/config.js` no-store); VPC origin (vpc_origin); WAF (us-east-1) CommonRuleSet, KnownBadInputs, IP rate rule, `SizeRestrictions_BODY` COUNT on `/api/dispute*`. Owns the ALB SG `:80` ingress rule: from SG `CloudFront-VPCOrigins-Service-SG` (looked up after the VPC origin exists) in vpc_origin, from prefix list `com.amazonaws.global.cloudfront.origin-facing` in public_alb. Providers: `aws`, `aws.us_east_1`. | `edge_origin_mode: string`<br>`alb_arn: string`<br>`alb_dns_name: string`<br>`alb_security_group_id: string`<br>`origin_secret_header_value: string` (sensitive, `null` in vpc_origin)<br>`waf_rate_limit: number` (requests per 5 min per IP, module default) | `distribution_id`<br>`distribution_arn`<br>`distribution_domain_name`: `dxxxx.cloudfront.net`<br>`web_origin`: `https://<distribution_domain_name>` (no trailing slash)<br>`web_acl_arn` | cognito (`callback_urls = ["${web_origin}/callback"]`, `logout_urls = ["${web_origin}/"]`); evidence-buckets (`allowed_upload_origin = web_origin`); ecs-service `web` (`OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_URI`); root outputs |
| `alb` | vpc_origin: **internal** ALB in private subnets, listener `:80` (default → `web-8080`; rules on header `x-cd-route: api` + path: `/me` → users, `/transactions*` → transactions, `/dispute*` and `/disputes` → disputes, other api paths fixed 404) and listener `:8081` (default fixed 404; `/users/*` → `users-8081`; `/dispute*`, `/disputes` → `disputes-8081`). public_alb: **public** ALB, `:80` only, same `:80` rules plus a required `x-cd-origin-secret` match (else 403), no `:8081`. Target type `ip`. Origin secret generated into `cd/dev/edge/origin-secret` (public_alb only). | `edge_origin_mode: string`<br>`vpc_id: string`<br>`public_subnet_ids: list(string)`<br>`private_subnet_ids: list(string)`<br>`security_group_id: string`<br>`data_kms_key_arn: string` | `alb_arn`<br>`alb_arn_suffix`: CloudWatch dimension<br>`alb_dns_name`<br>`web_listener_arn`: `:80`<br>`service_listener_arn`: `:8081` or `null`<br>`target_group_arns: map(string)`: keys in §2<br>`target_group_arn_suffixes: map(string)`: same keys<br>`service_port_base_url`: `http://<alb_dns_name>:8081` or `null`<br>`origin_secret_header_value`: sensitive, `null` in vpc_origin<br>`origin_secret_arn`: or `null` | edge (`alb_arn`, `alb_dns_name`, `origin_secret_header_value`); ecs-service (`target_group_arns`); lambda-fn intake/notifier (`service_port_base_url` → `DISPUTES_SERVICE_URL`/`USERS_SERVICE_URL`; fallback `http://<svc>.cd.internal:8081`); observability (`alb_arn_suffix`, `target_group_arn_suffixes`); dev-tools net-probe (`alb_dns_name`) |
| `messaging` | Queues `cd-dispute-notifications` (+ `-dlq`, maxReceiveCount 5, DLQ 14 days, visibility = 6 × notifier timeout), `cd-evidence-intake-dlq` (EventBridge target DLQ + intake async on-failure), `cd-retention-scheduler-dlq`; SSE-KMS `data`; queue policies: TLS-only, send only from `allowed_sender_role_arns`, receive/delete only `allowed_consumer_role_arns`, `events.amazonaws.com` SendMessage on the intake DLQ with `aws:SourceArn = evidence_scan_rule_arn`. | `kms_key_arn: string`<br>`notifier_timeout_seconds: number` (default 30)<br>`max_receive_count: number` (default 5)<br>`allowed_sender_role_arns: list(string)`<br>`allowed_consumer_role_arns: list(string)`<br>`evidence_scan_rule_arn: string` | `notifications_queue_url`<br>`notifications_queue_arn`<br>`notifications_dlq_arn`<br>`evidence_intake_dlq_arn`<br>`retention_scheduler_dlq_arn`<br>`dlq_names: map(string)`: DLQ key → queue name | ecs-service `disputes` (`notifications_queue_url`→`NOTIFICATIONS_QUEUE_URL`; statement `sqs:SendMessage` on `notifications_queue_arn` + `kms:GenerateDataKey`/`kms:Decrypt` on `data`); lambda-fn notifier (`sqs_event_source.queue_arn`), intake (`async_on_failure_arn`), sweeper (`schedule.dlq_arn`); evidence-buckets (`intake_dlq_arn`); observability (`dlq_names`) |
| `evidence-buckets` | Quarantine bucket (BPA, SSE-KMS `evidence` default, deny non-TLS, 1-day expiry, CORS `PUT` from `allowed_upload_origin` only with headers `content-type`, `x-amz-checksum-sha256`, `content-length`, deny `s3:GetObject` unless tag `GuardDutyMalwareScanStatus=NO_THREATS_FOUND` except the GuardDuty role); evidence bucket (versioned, SSE-KMS `evidence`, deny non-TLS, 365-day expiry on `evidence/`); GuardDuty Malware Protection plan + role (tagging on); EventBridge rule (`aws.guardduty`, `GuardDuty Malware Protection Object Scan Result`, quarantine bucket) → intake alias `live` with retry + DLQ; `aws_lambda_permission` for `events.amazonaws.com` with the rule `SourceArn`. | `kms_key_arn: string`<br>`allowed_upload_origin: string`<br>`enable_intake_target: bool` (= `contains(keys(var.lambda_image_uris), "evidence-intake")`)<br>`intake_function_name: string` (nullable)<br>`intake_alias_arn: string` (nullable)<br>`intake_dlq_arn: string`<br>`quarantine_expiration_days: number` (1)<br>`evidence_expiration_days: number` (365) | `quarantine_bucket_name`<br>`quarantine_bucket_arn`<br>`quarantine_bucket_regional_origin`: `https://<bucket>.s3.af-south-1.amazonaws.com`<br>`evidence_bucket_name`<br>`evidence_bucket_arn`<br>`guardduty_role_arn`<br>`malware_protection_plan_arn`<br>`scan_result_rule_arn` | ecs-service `disputes` (`QUARANTINE_BUCKET`; statement `s3:PutObject` on `${quarantine_bucket_arn}/*`, no GetObject); ecs-service `web` (`quarantine_bucket_regional_origin`→`UPLOAD_ORIGIN`); lambda-fn intake (`QUARANTINE_BUCKET`, `EVIDENCE_BUCKET`; Get/Delete on quarantine, PutObject on `${evidence_bucket_arn}/evidence/*`); messaging (`scan_result_rule_arn`); ci-roles e2e (both bucket ARNs, read-only checks) |
| `lambda-fn` (×0–3) | One arm64 image function `cd-<key>` (`ignore_changes = [image_uri]`), alias `live`, role, VPC config, log group, optional SQS ESM (`ReportBatchItemFailures`), optional EventBridge Scheduler schedule (+ role, DLQ, retry), optional async config. Instantiated by I-WIRE only for keys present in `lambda_image_uris`. | `function_key: string`<br>`image_uri: string`<br>`memory_mb: number` (256)<br>`timeout_seconds: number`<br>`subnet_ids: list(string)`<br>`security_group_id: string`<br>`environment: map(string)`<br>`policy_statements: <stmt>`<br>`data_kms_key_arn: string`<br>`sqs_event_source: object({ queue_arn = string, batch_size = optional(number, 10) })` (default `null`)<br>`schedule: object({ expression = string, timezone = string, dlq_arn = string })` (default `null`)<br>`async_on_failure_arn: string` (default `null`)<br>`async_max_retries: number` (default 2) | `function_name`: `cd-<key>`<br>`function_arn`<br>`alias_name`: `live`<br>`alias_arn`<br>`role_arn`<br>`role_name`<br>`log_group_name`: `/aws/lambda/cd-<key>` | evidence-buckets (intake `function_name`, `alias_arn`); messaging (notifier `role_arn` → `allowed_consumer_role_arns`); observability (`function_name`s) |
| `ses` | Email identity `ses_sender` (sandbox), configuration set (default on the identity) → EventBridge → SQS `cd-ses-events` (short retention, SSE-KMS `data`) for E-03 delivery checks. | `sender_email: string`<br>`kms_key_arn: string`<br>`events_retention_seconds: number` (default 86400) | `email_identity_arn`<br>`configuration_set_name`<br>`configuration_set_arn`<br>`ses_events_queue_url`<br>`ses_events_queue_arn` | lambda-fn notifier (`SES_SENDER`; statement `ses:SendEmail` on `[email_identity_arn, configuration_set_arn]` with `StringEquals ses:FromAddress = sender_email`); ci-roles e2e (`ses_events_queue_arn`) |
| `observability` | SNS `cd-alarms` (email, KMS `data`), dashboard `cd-dev`, alarms (DLQ depth ≥ 1 per DLQ; Lambda errors/throttles; `RetentionFailed`, `EventPublishFailed` for every `eventType`, `EvidenceNotScanned`, `EvidenceResultConflict`; ALB 5xx, p95 > 1 s, unhealthy hosts; Aurora at max ACU 15 min), explicit `treat_missing_data`; budget (forecast 100 %, actual 80 %/100 %, email subscriber). | `alert_email: string`<br>`budget_usd: number`<br>`kms_key_arn: string`<br>`dlq_names: map(string)`<br>`lambda_function_names: map(string)` (only created functions)<br>`alb_arn_suffix: string`<br>`target_group_arn_suffixes: map(string)`<br>`aurora_cluster_identifier: string`<br>`aurora_max_acu: number` | `alarm_topic_arn`<br>`dashboard_name`: `cd-dev`<br>`budget_name` | root outputs only |
| `ci-roles` | OIDC roles for pipelines: `publish-<repo key>` ×9 (sub `ref:refs/heads/main`, push to own repo only), `deploy-<svc>` ×5 (sub `environment:dev`, own service + own families, PassRole own task/exec roles), `deploy-lambda-<key>` ×3 (environment dev, own function + alias), `run-tools` (RunTask on tool families, PassRole tool roles), `e2e` (AdminInitiateAuth on the pool, read seed-user secrets, receive/delete `cd-ses-events`, read-only listings, Reachability Analyzer). Audience `sts.amazonaws.com`, exact `sub` (never `*`). No role can call `iam:*` or touch another deployable. Lambda ARNs are built from names, so the roles exist before the functions (phase A). | `github_repo: string`<br>`github_oidc_provider_arn: string`<br>`ecr_repository_arns: map(string)`<br>`ecs_cluster_arn: string`<br>`ecs_deployables: map(object({ service_arn = string, task_definition_families = list(string), pass_role_arns = list(string) }))` (service keys)<br>`lambda_function_names: map(string)` (all three Lambda keys)<br>`dev_tools: object({ task_definition_families = list(string), pass_role_arns = list(string) })`<br>`cognito_user_pool_arn: string`<br>`seed_user_secret_name_prefix: string` (`cd/dev/seed-users/`)<br>`ses_events_queue_arn: string`<br>`evidence_bucket_arns: list(string)`<br>`data_kms_key_arn: string` | `role_arns: map(string)`: keys `publish-<repo key>`, `deploy-<svc>`, `deploy-lambda-<key>`, `run-tools`, `e2e` | root outputs → GitHub Environment `dev` variables (runbook) |
| `dev-tools` | Task definitions `cd-db-bootstrap` (`DB_ADMIN_HOST/_PORT/_NAME` plain, `DB_ADMIN_USER/_PASSWORD` from master secret keys, `DB_PASSWORD_<ROLE>` from role secrets), `cd-dev-seed` (migrator URLs, Cognito admin on the pool, create/put seed-user secrets), `cd-net-probe` (in-VPC V-10 checks); per-task task + execution roles; one log group per task. | `cluster_arn: string`<br>`image_uri: string`<br>`subnet_ids: list(string)`<br>`security_group_id: string`<br>`data_kms_key_arn: string`<br>`aurora: object({ endpoint = string, port = number, database_name = string, master_secret_arn = string, role_secret_arns = map(string) })`<br>`cognito_user_pool_arn: string`<br>`cognito_user_pool_id: string`<br>`seed_user_secret_name_prefix: string`<br>`probe_environment: map(string)` | `task_definition_families: map(string)`: tool key → family<br>`task_definition_arns: map(string)`<br>`task_role_arns: map(string)`<br>`execution_role_arns: map(string)`<br>`log_group_names: map(string)` | ci-roles (`dev_tools.task_definition_families`, `pass_role_arns = concat(values(task_role_arns), values(execution_role_arns))`) |

## 5. Wiring order and cycle notes (for I-WIRE)

```
network → security → { ecr, ecs-cluster, aurora, messaging, ses, alb }
alb → edge → { cognito (callback URLs), evidence-buckets (CORS) }
{ cognito, aurora, alb, messaging, evidence-buckets, ses } → ecs-service ×5, lambda-fn ×0–3, dev-tools
{ ecs-service, lambda-fn, dev-tools, ecr, ecs-cluster } → ci-roles, observability
```
These module-level loops are safe because each closes at a separate resource:
- `messaging.allowed_consumer_role_arns` ← notifier role, while the notifier ESM ← queue ARN (closes at `aws_sqs_queue_policy`).
- `messaging.evidence_scan_rule_arn` ← rule, while the rule target ← intake DLQ ARN (closes at the queue policy / `aws_cloudwatch_event_target`).
- `alb.origin_secret_header_value` → edge, while edge → `alb_dns_name` (separate resources).

Service URLs: peers `http://<svc>:8081` (Service Connect); Lambdas `alb.service_port_base_url` in vpc_origin,
`http://<svc>.cd.internal:8081` in public_alb.
ECS autoscaling targets are registered only when `var.enable_service_autoscaling = true` (after the first deploy).
Otherwise registering min 1 would start tasks before any image exists.
