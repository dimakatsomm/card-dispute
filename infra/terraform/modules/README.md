# Terraform modules — interface contract (M3)

This file is the contract between the wave-1 modules (I-00 … I-15) and I-WIRE, brought in line with the modules as
built. The interface table (§4) lists exactly the inputs and outputs in each `variables.tf` / `outputs.tf`. Change this
file first (via the orchestrator) if a name or type must change; never diverge silently.

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

**Names other modules rely on** (built from the pattern, not passed as inputs, so the dependent resource needs no
output from the module it names; renaming any of these breaks the dependents):

| Name | Relied on by |
|---|---|
| Tool roles `cd-db-bootstrap-task` / `-exec`, `cd-dev-seed-task` / `-exec`, `cd-net-probe-task` / `-exec` (path `/cd/`) | ci-roles (`PassRole` for `run-tools` and `e2e` net-probe; the net-probe pair is built from the name, not from `dev_tools.pass_role_arns`) |
| Task definition families `cd-<tool>` (`cd-db-bootstrap`, `cd-dev-seed`, `cd-net-probe`) | ci-roles |
| Role `cd-disputes-task` (path `/cd/`) | security (`evidence` key policy: `GenerateDataKey` allowed, `Decrypt` denied) |
| Queue names `cd-dispute-notifications`, `cd-dispute-notifications-dlq`, `cd-evidence-intake-dlq`, `cd-retention-scheduler-dlq`, `cd-ses-events` | ci-roles (`e2e` queue depths), observability (`dlq_names`) |
| Lambda function names `cd-<key>` (`cd-evidence-intake`, `cd-dispute-notifier`, `cd-retention-sweeper`) and ARNs built from them | ci-roles (deploy roles exist before the functions), ecr (pull policy pattern `function:cd-*`), bootstrap apply role |
| Cluster `cd-cluster`, namespace `cd.internal` | ci-roles, ecs-service, bootstrap apply role |
| Lambda alias `live` | evidence-buckets (EventBridge target), lambda-fn (ESM, Scheduler), ci-roles (`deploy-lambda-*`) |
| Secret prefix `cd/dev/seed-users/` | ci-roles `e2e`, dev-tools `dev-seed`, boundary |

### Tags
Tags come from `default_tags` on both providers in `envs/dev/providers.tf` (`project`, `environment=dev`,
`managed-by=terraform`, `repo`). Modules do not set those tags; they may add `component = "<module dir>"`.

### Module shape
- Files: `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, `tests/*.tftest.hcl`. No `provider` blocks in modules.
- `versions.tf`: `required_version = ">= 1.10"`, `hashicorp/aws` `">= 6.67, < 7.0"` (plus `hashicorp/random` if used:
  `cognito`, `aurora`, `alb`).
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
  (`sensitive = true`, `public_alb` mode only, consumed only by `edge`).

### Types shared by several modules
- `<stmt>` (`ecs-service.task_role_statements`, `lambda-fn.policy_statements`) is
  `list(object({ Sid = string, Effect = string, Action = list(string), Resource = list(string), Condition = optional(map(map(list(string)))) }))`.
  `Condition` is `optional(map(map(list(string))))`: **every Condition value is a list**, even a single string
  (`{ StringEquals = { "ses:FromAddress" = [var.sender_email] } }`). A validation rejects `"*"` and `service:*` in
  `Action` and `"*"` in `Resource`.
- `<secret_ref>` is `map(object({ secret_arn = string, json_key = optional(string) }))` (env var name → secret;
  ECS renders `valueFrom = "<arn>:<json_key>::"`).

### Health checks
- Container health check (Dockerfile `HEALTHCHECK` / task definition) is `/health` (web: `/healthz`). It is liveness
  only, so a paused database never restarts healthy tasks.
- ALB target groups health-check `/ready` (web: `/healthz`) with lenient thresholds, so a paused database drains
  traffic instead of restarting tasks (ADR-066). `:8081` target groups health-check on port `8080`.
- `ecs-service.health_check_path` is the **target group** path (`/ready`, web `/healthz`); the container check is fixed.

### Phase A / phase B (ADR-066)
Phase A applies before any image exists; phase B adds what needs an image.
- **Always exist (phase A):** each `lambda-fn` instance's execution role, log group and (when `schedule` is set) the
  Scheduler execution role; ECS services at desired 0; ci-roles (Lambda ARNs are built from names).
- **Wait for `image_uri` (phase B):** the Lambda function, alias `live`, event source mapping, Scheduler schedule,
  async config. With `image_uri = null` the function outputs (`function_name`, `function_arn`, `alias_name`,
  `alias_arn`) are `null`; `role_arn`, `role_name`, `log_group_name` and `scheduler_role_arn` stay populated.
- I-WIRE therefore instantiates `lambda-fn` for **all three** keys and passes `image_uri = lookup(lambda_image_uris, key, null)`;
  `evidence-buckets.enable_intake_target` is `contains(keys(var.lambda_image_uris), "evidence-intake")`.

### IAM
- Policy documents are HCL objects in `locals` rendered with `jsonencode(...)`. Do **not** use
  `data "aws_iam_policy_document"`: under `mock_provider` its `json` is a random string, so tests cannot assert
  on it. Tests assert with `jsondecode(<resource>.policy).Statement`.
- Every statement has a `Sid`. Actions and resources are listed explicitly.
- **No `"*"` and no `service:*` in `Action`; no `"*"` in `Resource`**, except the cases below. Each exception
  carries a one-line inline comment naming the AWS reason, and a `Condition` where one exists.

| Exception | Where | Why |
|---|---|---|
| `Resource = "*"` in a KMS **key policy** | security (`cd-data`, `cd-evidence`), bootstrap (state key) | In a key policy `*` means "this key". Statements still list explicit actions (no `kms:*`, also for the account-root admin statement). |
| `ecr:GetAuthorizationToken` on `*` | ecs-service execution roles, dev-tools execution roles, ci-roles `publish-*` | Action has no resource-level permission. |
| `ecs:RegisterTaskDefinition`, `ecs:DescribeTaskDefinition` on `*` | ci-roles `deploy-*` | No resource-level permission. |
| `elasticloadbalancing:DescribeTargetHealth` on `*` | ci-roles `deploy-*` (rollout wait) | No resource-level permission. |
| `ec2:CreateNetworkInterface`, `ec2:DeleteNetworkInterface`, `ec2:AssignPrivateIpAddresses`, `ec2:UnassignPrivateIpAddresses` on `*` | lambda-fn role (VPC functions) | Lambda creates ENIs with unknown ids (`AWSLambdaVPCAccessExecutionRole` documents `*`). |
| `ec2:DescribeNetworkInterfaces` on `*` | lambda-fn role | Describe actions have no resource-level permission. |
| `ec2:DescribeNetworkInsightsAnalyses`, `ec2:DescribeNetworkInsightsPaths`, `ec2:DescribeNetworkInterfaces`, `ec2:DescribeSecurityGroups`, `ec2:DescribeSubnets`, `ec2:DescribeVpcs` on `*` | ci-roles `e2e` (Reachability Analyzer read) | EC2 Describe has no resource-level permission; actions enumerated, no `ec2:*`. |
| `ec2:CreateNetworkInsightsPath`, `ec2:StartNetworkInsightsAnalysis` on `*` | ci-roles `e2e` | No resource-level permission; condition `aws:RequestTag/<insights tag key> = <e2e role name>` marks what the role may later delete. |
| `arn:…:secret:cd/dev/seed-users/*` (trailing-`*` partial wildcard on a name prefix) | dev-tools `dev-seed`, ci-roles `e2e`, boundary | Secrets are created at run time by dev-seed, so ARNs are unknown. |
| `NotAction` region guard with `Resource = "*"` (`DenyOutsideAllowedRegions`; exempts `iam`, `sts`, `cloudfront`, `route53`, `budgets`, `support`) | bootstrap apply role | AWS's documented region-guard pattern; Deny only. |
| `cognito-idp:CreateUserPool`, `ecs:RegisterTaskDefinition`, `ecs:DeregisterTaskDefinition`, `kms:CreateKey`, `servicediscovery:CreatePrivateDnsNamespace` on `*` | bootstrap apply role | Create actions have no resource-level permission (the resource does not exist yet); region condition. |
| `lambda:CreateEventSourceMapping` on `*` | bootstrap apply role | No resource-level permission; condition `lambda:FunctionArn = function:cd-*`. |
| `route53:CreateHostedZone` on `*` | bootstrap apply role | Cloud Map private namespaces create a hosted zone; no resource-level permission. |
| `NoResourceLevelActions` on `*` (`cloudwatch:DescribeAlarms/GetMetricData/PutMetricData`, the ENI and Reachability actions above, `ecr:GetAuthorizationToken`, `ecs:*TaskDefinition`, `elasticloadbalancing:DescribeTargetHealth`) | bootstrap permissions boundary | Ceiling for the same no-resource-level actions as above; region condition. Roles still list them explicitly. |
| `Resource = "*"` on `DenyIamExceptPassRole` (IAM action globs) and `DenyOrganizations` (`organizations:*`) | bootstrap permissions boundary | Deny-only wildcards: no workload may manage IAM or touch Organizations. |
| `Principal = "*"` / `Action = "s3:*"` in `Deny` statements | evidence-buckets (`DenyNonTls`, `DenyReadUnlessScannedClean`, `DenyTagWritesExceptGuardDuty`, `DenyUploadWithScanTag`, `DenyUploadOutsideIntake`), bootstrap state bucket, messaging and ses queue policies (`DenyNonTls`, `DenySend…`, `DenyConsume…`), security `cd-evidence` key (`DenyDisputesTaskDecrypt`) | Deny-only: a TLS-only or allow-list guard must apply to every principal. |

- Bucket/queue/key policies may use `Principal = "*"` only in `Deny` statements.
- Partial wildcards on **named** resource prefixes (`log-stream:*` under one log group, `arn:…:function:cd-*`,
  `cd-*` patterns in the bootstrap apply role, `${bucket}/*` objects) are not exceptions to this rule.
- Not used and so not allowed without a new row: `cloudwatch:PutMetricData` (EMF via logs needs none).

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
| Cognito service client keys | keys of `modules/cognito/grants.json` (`svc-users`, `svc-transactions`, `svc-disputes`, `svc-notifier`, `svc-evidence-intake`; kept equal to mock-issuer `SERVICE_GRANTS`) |
| Security group keys | `alb`, `auth`, `users`, `transactions`, `disputes`, `web`, `evidence-intake`, `dispute-notifier`, `retention-sweeper`, `aurora`, `dev-tools` |
| KMS key keys | `data` (Aurora, Secrets Manager, SQS, logs, SNS, ECR), `evidence` (quarantine + evidence buckets) |
| ALB target group keys | `web-8080`, `users-8080`, `transactions-8080`, `disputes-8080`; `users-8081`, `disputes-8081` only when `edge_origin_mode = "vpc_origin"` |
| DLQ keys | `notifications`, `evidence-intake`, `retention-scheduler` |
| Ports | public `8080`, service `8081` (web: `8080` only); Aurora `5432` |
| Health | container `/health` (web `/healthz`); ALB target groups `/ready` (web `/healthz`), lenient thresholds; 8081 target groups health-check on port `8080` |
| Service Connect | namespace `cd.internal`; discovery names = service keys, so peers use `http://<service>:8081` |
| Lambda alias | `live` |
| Edge headers | `x-cd-route` (`api` on the API origin, `web` on the web origin; origin custom headers override viewer values), `x-cd-origin-secret` (public_alb only) |
| EMF namespaces | `cd/disputes`, `cd/evidence-intake`, `cd/retention-sweeper` |
| SPA paths | callback `/callback`, post-logout `/`, API base `/api` |

## 3. Security group matrix (the `security` module owns every rule except ALB `:80`, which `edge` owns)

Every flow is a pair: an ingress rule on the target SG and an egress rule on the source SG, both by SG reference.
There are no CIDR ingress rules. Egress is scoped: only the flows below plus the two `:443` rules.

| SG | Ingress | Egress |
|---|---|---|
| `alb` | `:80` from CloudFront (**rule owned by `edge`**: SG `CloudFront-VPCOrigins-Service-SG` in vpc_origin, prefix list `com.amazonaws.global.cloudfront.origin-facing` in public_alb); vpc_origin only: `:8081` from `evidence-intake`, `dispute-notifier` | `:8080` to `users`, `transactions`, `disputes`, `web`; vpc_origin only: `:8081` to `users`, `disputes` |
| `auth` | `:8081` from `users`, `transactions`, `disputes` | `:443` to `0.0.0.0/0` (NAT: Cognito JWKS, Secrets Manager, ECR, Logs) and to the S3 prefix list; `:5432` to `aurora` |
| `users` | `:8080` from `alb`; `:8081` from `transactions`, `disputes`, plus `alb` (vpc_origin) or `evidence-intake`, `dispute-notifier` (public_alb) | `:443` any and S3 prefix list; `:5432` `aurora`; `:8081` `auth` |
| `transactions` | `:8080` from `alb`; `:8081` from `disputes` | `:443` any and S3; `:5432` `aurora`; `:8081` `auth`, `users`, `disputes` |
| `disputes` | `:8080` from `alb`; `:8081` from `transactions`, plus `alb` (vpc_origin) or `evidence-intake`, `dispute-notifier` (public_alb) | `:443` any and S3; `:5432` `aurora`; `:8081` `auth`, `users`, `transactions` |
| `web` | `:8080` from `alb` | `:443` any and S3 (ECR pull, Logs) |
| `evidence-intake` | none | `:443` any and S3; `:8081` to `alb` (vpc_origin) or to `users`, `disputes` (public_alb, Cloud Map) |
| `dispute-notifier` | none | `:443` any (no S3 rule); `:8081` to `alb` (vpc_origin) or to `users`, `disputes` (public_alb, Cloud Map) |
| `retention-sweeper` | none | `:443` any (no S3 rule); `:5432` `aurora` |
| `dev-tools` | none | `:443` any and S3; `:5432` `aurora`. No rule to `alb` or to services: net-probe proves the denials (ADR-067) |
| `aurora` | `:5432` from `auth`, `users`, `transactions`, `disputes`, `retention-sweeper`, `dev-tools` | none |

The ALB has no `:8081` rules in `public_alb` mode (no `:8081` listener); `users` and `disputes` take `:8081` from the
two Lambda SGs directly instead. `:443` egress to `0.0.0.0/0` is required because there are no interface endpoints
(NAT decision, docs/06).

### KMS service principals on `cd-data`
The `data` key policy admits, in addition to account-root admin and `ViaService` use (`secretsmanager`, `sqs`, `rds`,
`ecr`, `sns`) and grants for AWS resources:

| Principal | Actions | Condition |
|---|---|---|
| `logs.af-south-1.amazonaws.com` | the `use_actions` set | `aws:SourceAccount`; `kms:EncryptionContext:aws:logs:arn` like `log-group:/cd/*`, `log-group:/aws/lambda/cd-*` and `log-group:/aws/rds/cluster/cd-*` (Aurora log export) |
| `events.amazonaws.com` | `kms:Decrypt`, `kms:GenerateDataKey` | `aws:SourceAccount` |
| `cloudwatch.amazonaws.com` | `kms:Decrypt`, `kms:GenerateDataKey` | `aws:SourceAccount` |
| `budgets.amazonaws.com` | `kms:Decrypt`, `kms:GenerateDataKey` | `aws:SourceAccount` |

The `evidence` key adds `GenerateDataKey` for the `cd-disputes-task` role via S3 only and an explicit Deny of
`Decrypt`/`CreateGrant`/`ReEncrypt*` for that role.

## 4. Interface table

Notation: `name: type`. **R** = contract-required (no default; I-WIRE must pass it). **O** = optional, with its
default. Every module takes `name_prefix: string` (R) and the rows list it too.
`<stmt>` and `<secret_ref>` are defined in §1.

| Module dir | Purpose | Inputs | Outputs | Consumed by |
|---|---|---|---|---|
| `bootstrap` (root, `infra/terraform/bootstrap`) | State bucket (versioned, KMS, TLS-only, BPA, prevent_destroy), GitHub OIDC provider, `gha-infra-plan` / `gha-infra-apply`, permissions boundary. Applied once by the owner (OWN-4). | R `github_repo`: string<br>O `name_prefix`: string = `"cd"`<br>O `state_bucket_name`: string = `null` (must not start with `<name_prefix>-dev-`) | `state_bucket_name`: bucket for `-backend-config` and `plans/<sha>`<br>`state_kms_key_arn`: state/plan encryption key (backend `kms_key_id`)<br>`github_oidc_provider_arn`: provider for `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`<br>`infra_plan_role_arn`: sub `repo:<repo>:ref:refs/heads/main`<br>`infra_apply_role_arn`: sub `repo:<repo>:environment:dev`<br>`permissions_boundary_arn`: policy `cd-workload-boundary` | No remote state. `envs/dev` backend config (bucket, `kms_key_id`); GitHub Environment vars (role ARNs, bucket). I-WIRE rebuilds the OIDC provider ARN and boundary ARN from the fixed names + `aws_caller_identity` and passes them to `ci-roles` and every role-creating module. |
| `network` | VPC, 2 AZs, public + private subnets, 1 NAT gateway, S3 gateway endpoint, no interface endpoints. Optional flow logs. | R `name_prefix`: string<br>R `vpc_cidr`: string<br>O `az_count`: number = `2`<br>O `enable_flow_logs`: bool = `false`<br>O `log_retention_days`: number = `7`<br>O `logs_kms_key_arn`: string = `null`<br>O `permissions_boundary_arn`: string = `null`<br>O `iam_path`: string = `"/cd/"` | `vpc_id`: VPC id<br>`vpc_cidr`: CIDR<br>`public_subnet_ids`: list(string), NAT and public ALB (fallback)<br>`private_subnet_ids`: list(string), ECS, Aurora, Lambdas, internal ALB<br>`private_route_table_ids`: default route via NAT + S3 gateway route<br>`s3_prefix_list_id`: S3 gateway prefix list<br>`nat_public_ip`: NAT EIP | security (`vpc_id`, `s3_prefix_list_id`); ecs-cluster (`vpc_id`); alb (`vpc_id`, both subnet lists); aurora, ecs-service, lambda-fn, dev-tools (`private_subnet_ids`) |
| `security` | KMS keys `cd-data`, `cd-evidence` (rotation on; key policy per §3 KMS table); every SG and every rule in §3 except ALB `:80`. | R `name_prefix`: string<br>R `vpc_id`: string<br>R `s3_prefix_list_id`: string<br>R `edge_origin_mode`: string (`vpc_origin` or `public_alb`) | `kms_key_arns`: map(string), keys `data`, `evidence`<br>`security_group_ids`: map(string), keys in §2 | **all** modules: aurora (`aurora` SG, `data`); ecs-service (own SG, `data`); lambda-fn (own SG, `data`); dev-tools (`dev-tools` SG, `data`); alb (`alb` SG, `data`); edge (`alb` SG id); messaging, ses, observability, cognito, ecr (`data`); evidence-buckets (`evidence`); log groups (`data` as `logs_kms_key_arn`) |
| `cognito` | User pool (admin-create-only, access 15 min, refresh 1 day), prefix domain (`domain_suffix` or random), resource servers `auth{validate}`, `users{cards.read,contact.read}`, `transactions{read}`, `disputes{read,evidence.write}`; `spa` client (code + PKCE, `openid`); one client_credentials client per `grants.json` key; optional `e2e` client (`ALLOW_ADMIN_USER_PASSWORD_AUTH` only); client secrets as raw-string secrets `cd/dev/cognito/<client>`. Reads `${path.module}/grants.json` = `{ "<client>": ["<rs>/<scope>", …] }`. Uses `hashicorp/random`. | R `name_prefix`: string<br>R `callback_urls`: list(string)<br>R `logout_urls`: list(string)<br>R `enable_e2e_client`: bool<br>R `secrets_kms_key_arn`: string<br>O `deletion_protection`: bool = `true`<br>O `domain_suffix`: string = `null` (random when null) | `user_pool_id`<br>`user_pool_arn`<br>`issuer_url`: `https://cognito-idp.af-south-1.amazonaws.com/<pool-id>`<br>`jwks_url`: `<issuer_url>/.well-known/jwks.json`<br>`hosted_ui_base_url`: `https://<prefix>.auth.af-south-1.amazoncognito.com`<br>`token_url`: `<hosted_ui_base_url>/oauth2/token`<br>`spa_client_id`<br>`e2e_client_id`: id or `null`<br>`user_client_ids`: list(string), spa (+ e2e)<br>`service_client_ids`: map(string), client key → id<br>`service_client_secret_arns`: map(string), client key → secret ARN | ecs-service `auth` (`issuer_url`→`AUTH_ISSUER_URL`, `jwks_url`→`AUTH_JWKS_URI`, `user_client_ids`→`AUTH_USER_CLIENT_IDS`, `values(service_client_ids)`→`AUTH_SERVICE_CLIENT_IDS`, comma-joined); `users`/`transactions`/`disputes` (`token_url`→`TOKEN_URL`, `service_client_ids["svc-<svc>"]`→`SERVICE_CLIENT_ID`, secret→`SERVICE_CLIENT_SECRET`); `web` (`issuer_url`→`OIDC_ISSUER`, `spa_client_id`→`OIDC_CLIENT_ID`, `hosted_ui_base_url`→`OIDC_TOKEN_ORIGIN`, `<hosted_ui_base_url>/logout`→`OIDC_LOGOUT_URL`); lambda-fn intake/notifier (`token_url`, client id, secret ARN); dev-tools (`user_pool_arn`, `user_pool_id`); ci-roles (`user_pool_arn`) |
| `aurora` | Aurora PostgreSQL Serverless v2, 1 writer, DB `disputes`, private subnet group, `rds.force_ssl=1`, RDS-managed master secret (KMS `data`), log export to a CMK log group, 7-day backups; nine role secrets `cd/dev/db/<role>` JSON `{username,password,host,port,dbname,url}` with `url` `postgres://…?sslmode=verify-full`; `disputes_retention` adds `engine` (RDS format). No rotation (deferred). | R `name_prefix`: string<br>R `subnet_ids`: list(string)<br>R `security_group_id`: string<br>R `kms_key_arn`: string<br>R `min_acu`: number<br>R `max_acu`: number<br>R `logs_kms_key_arn`: string (a `data` key ARN; the log group is encrypted with it)<br>O `deletion_protection`: bool = `true`<br>O `skip_final_snapshot`: bool = `false`<br>O `database_name`: string = `"disputes"`<br>O `backup_retention_days`: number = `7`<br>O `engine_version`: string = `"18.3"`<br>O `log_retention_days`: number = `7` | `cluster_arn`<br>`cluster_identifier`: for alarms<br>`cluster_resource_id`: `cluster-XXXX`<br>`endpoint`: writer hostname<br>`port`: 5432<br>`database_name`: `disputes`<br>`master_secret_arn`: RDS-managed `{username,password}` only<br>`role_secret_arns`: map(string), DB role key → secret ARN | ecs-service (`role_secret_arns["<svc>_app"]` key `url`→`DATABASE_URL`; `["<svc>_migrator"]` key `url`→`MIGRATOR_DATABASE_URL` on the migrate task); lambda-fn sweeper (`role_secret_arns["disputes_retention"]`→`DATABASE_SECRET_ID`); dev-tools (`aurora` object from `master_secret_arn`, `endpoint`, `port`, `database_name`, `role_secret_arns`); observability (`cluster_identifier`) |
| `ecr` | Nine repos `cd-<repo key>`: immutable tags, scan on push, keep last 10, KMS; Lambda image pull policy for `function:cd-*`. | R `name_prefix`: string<br>R `kms_key_arn`: string<br>O `repository_keys`: list(string) = the nine keys in §2<br>O `keep_images`: number = `10` | `repository_urls`: map(string), repo key → `<acct>.dkr.ecr.af-south-1.amazonaws.com/cd-<key>`<br>`repository_arns`: map(string)<br>`repository_names`: map(string) | ecs-service (`image_uri = "${repository_urls[k]}:initial"`, never pulled at desired 0); dev-tools (`repository_urls["dev-tools"]`); ci-roles (`repository_arns`) |
| `ecs-cluster` | Cluster `cd-cluster` (Container Insights off) and Cloud Map **private DNS** namespace `cd.internal` (Service Connect default; also serves fallback DNS registration). | R `name_prefix`: string<br>R `vpc_id`: string | `cluster_arn`<br>`cluster_name`: `cd-cluster`<br>`namespace_arn`: `cd.internal`<br>`namespace_id`<br>`namespace_name`: `cd.internal` | ecs-service (`cluster_arn`, `namespace_arn`, `namespace_id`); dev-tools (`cluster_arn`); ci-roles (`cluster_arn`) |
| `ecs-service` (×5) | One Fargate service + task def (ARM64, 0.25 vCPU / 0.5 GB, non-root, read-only root + `/tmp` volume), `desired_count` default 0 with `ignore_changes = [task_definition, desired_count]`, circuit breaker + rollback, Service Connect server `<svc>:8081` (backend services), ALB attachments, optional autoscaling, task role, execution role (reads only the listed secrets), optional migrate task def `cd-<svc>-migrate`, log group. Container health `/health` (web `/healthz`). | R `name_prefix`: string<br>R `service_name`: string (service key)<br>R `permissions_boundary_arn`: string<br>R `iam_path`: string<br>R `log_retention_days`: number<br>R `logs_kms_key_arn`: string<br>R `cluster_arn`: string<br>R `namespace_arn`: string<br>R `namespace_id`: string<br>R `image_uri`: string<br>R `subnet_ids`: list(string)<br>R `security_group_id`: string<br>R `service_connect_server`: bool<br>R `health_check_path`: string (target group path, §1)<br>R `data_kms_key_arn`: string<br>O `cpu`: number = `256`<br>O `memory`: number = `512`<br>O `register_cloud_map_service`: bool = `false` (public_alb fallback, users + disputes)<br>O `target_groups`: map(object({ arn = string, container_port = number })) = `{}` (keys `"8080"`, `"8081"`)<br>O `environment`: map(string) = `{}`<br>O `secrets`: `<secret_ref>` = `{}`<br>O `migrate`: object({ command = list(string), environment = map(string), secrets = `<secret_ref>` }) = `null` (plan-known)<br>O `task_role_statements`: `<stmt>` = `[]`<br>O `enable_autoscaling`: bool = `false`<br>O `autoscaling_min_capacity`: number = `1`<br>O `autoscaling_max_capacity`: number = `2`<br>O `autoscaling_cpu_target`: number = `60`<br>O `desired_count`: number = `0` | `service_name`: `cd-<svc>`<br>`service_arn`<br>`task_definition_family`: `cd-<svc>`<br>`migrate_task_definition_family`: `cd-<svc>-migrate` or `null`<br>`task_role_arn`<br>`task_role_name`<br>`execution_role_arn`<br>`log_group_name`: `/cd/dev/ecs/<svc>` | ci-roles (`service_arn`, both families, `task_role_arn` + `execution_role_arn` for PassRole); messaging (`disputes` `task_role_arn` → `allowed_sender_role_arns`) |
| `edge` | CloudFront distribution (default cert, TLSv1.2_2021): origins `alb-api` (custom header `x-cd-route: api`, + `x-cd-origin-secret` in public_alb) and `alb-web` (`x-cd-route: web`) on the same ALB; `/api/*` → `https-only` (web paths redirect-to-https), Function strips `/api`, no cache, forwards `Authorization`, `If-Match`, `x-correlation-id`; `/*` static caching (`/config.js` no-store); VPC origin (vpc_origin); WAF (us-east-1) CommonRuleSet, KnownBadInputs, IP rate rule, `SizeRestrictions_BODY` COUNT on `/api/dispute*`. Owns the ALB SG `:80` ingress rule (§3). Providers: `aws`, `aws.us_east_1`. | R `name_prefix`: string<br>R `edge_origin_mode`: string<br>R `alb_arn`: string<br>R `alb_dns_name`: string<br>R `alb_security_group_id`: string<br>O `origin_secret_header_value`: string = `null` (sensitive; required in public_alb, `null` in vpc_origin)<br>O `waf_rate_limit`: number = `2000` (requests per 5 min per IP) | `distribution_id`<br>`distribution_arn`<br>`distribution_domain_name`: `dxxxx.cloudfront.net`<br>`web_origin`: `https://<distribution_domain_name>` (no trailing slash)<br>`web_acl_arn` | cognito (`callback_urls = ["${web_origin}/callback"]`, `logout_urls = ["${web_origin}/"]`); evidence-buckets (`allowed_upload_origin = web_origin`); ecs-service `web` (`OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_URI`); root outputs |
| `alb` | vpc_origin: **internal** ALB in private subnets, listener `:80` (default → `web-8080`; rules on header `x-cd-route: api` + path: `/me` → users, `/transactions*` → transactions, `/dispute*` and `/disputes` → disputes, other api paths fixed 404) and listener `:8081` (default fixed 404; `/users/*` → `users-8081`; `/dispute*`, `/disputes` → `disputes-8081`). public_alb: **public** ALB, `:80` only, same `:80` rules plus a required `x-cd-origin-secret` match (else 403), no `:8081`. Target type `ip`; target groups health-check `/ready` (web `/healthz`), lenient. Origin secret generated into `cd/dev/edge/origin-secret` (public_alb only). | R `name_prefix`: string<br>R `edge_origin_mode`: string<br>R `vpc_id`: string<br>R `public_subnet_ids`: list(string)<br>R `private_subnet_ids`: list(string)<br>R `security_group_id`: string<br>R `data_kms_key_arn`: string<br>O `deletion_protection`: bool = `true` | `alb_arn`<br>`alb_arn_suffix`: CloudWatch dimension<br>`alb_dns_name`<br>`web_listener_arn`: `:80`<br>`service_listener_arn`: `:8081` or `null`<br>`target_group_arns`: map(string), keys in §2<br>`target_group_arn_suffixes`: map(string), same keys<br>`service_port_base_url`: `http://<alb_dns_name>:8081` or `null`<br>`origin_secret_header_value`: sensitive, `null` in vpc_origin<br>`origin_secret_arn`: or `null` | edge (`alb_arn`, `alb_dns_name`, and in public_alb `origin_secret_header_value`); ecs-service (`target_group_arns`); lambda-fn intake/notifier (`service_port_base_url` → `DISPUTES_SERVICE_URL`/`USERS_SERVICE_URL`; fallback `http://<svc>.cd.internal:8081`); observability (`alb_arn_suffix`, `target_group_arn_suffixes`); dev-tools net-probe (`alb_dns_name`) |
| `messaging` | Queues `cd-dispute-notifications` (+ `-dlq`, maxReceiveCount 5, DLQ 14 days, visibility = 6 × notifier timeout = 180 s), `cd-evidence-intake-dlq` (EventBridge target DLQ + intake async on-failure), `cd-retention-scheduler-dlq`; SSE-KMS `data`; queue policies: TLS-only, send only from the allow-lists, receive/delete only `allowed_consumer_role_arns`, `events.amazonaws.com` SendMessage on the intake DLQ with `aws:SourceArn = evidence_scan_rule_arn`. | R `name_prefix`: string<br>R `kms_key_arn`: string<br>R `allowed_sender_role_arns`: list(string) (non-empty)<br>R `allowed_consumer_role_arns`: list(string) (non-empty)<br>R `evidence_scan_rule_arn`: string<br>R `evidence_intake_role_arns`: list(string) (non-empty; may send to the intake DLQ)<br>R `retention_scheduler_role_arns`: list(string) (non-empty; may send to the scheduler DLQ)<br>O `notifier_timeout_seconds`: number = `30`<br>O `max_receive_count`: number = `5`<br>O `redrive_operator_arns`: list(string) = `[]` | `notifications_queue_url`<br>`notifications_queue_arn`<br>`notifications_dlq_arn`<br>`evidence_intake_dlq_arn`<br>`retention_scheduler_dlq_arn`<br>`dlq_names`: map(string), DLQ key → queue name | ecs-service `disputes` (`notifications_queue_url`→`NOTIFICATIONS_QUEUE_URL`; statement `sqs:SendMessage` on `notifications_queue_arn` + `kms:GenerateDataKey`/`kms:Decrypt` on `data`); lambda-fn notifier (`sqs_event_source.queue_arn`), intake (`async_on_failure_arn`), sweeper (`schedule.dlq_arn`); evidence-buckets (`intake_dlq_arn`); observability (`dlq_names`) |
| `evidence-buckets` | Quarantine bucket (BPA, SSE-KMS `evidence` default, deny non-TLS, 1-day expiry, CORS `PUT` from `allowed_upload_origin` only with headers `content-type`, `x-amz-checksum-sha256`, `content-length`, deny `s3:GetObject` unless tag `GuardDutyMalwareScanStatus=NO_THREATS_FOUND` except the GuardDuty role; only the GuardDuty role may write/delete object tags, upload with a `GuardDutyMalwareScanStatus` tag, or upload outside `intake/*` (its validation object)); evidence bucket (versioned, SSE-KMS `evidence`, deny non-TLS, 365-day expiry on `evidence/`); GuardDuty Malware Protection plan + role (tagging on); EventBridge rule (`aws.guardduty`, `GuardDuty Malware Protection Object Scan Result`, quarantine bucket) → intake alias `live` with retry + DLQ; `aws_lambda_permission` for `events.amazonaws.com` with the rule `SourceArn`. | R `name_prefix`: string<br>R `permissions_boundary_arn`: string<br>R `iam_path`: string<br>R `kms_key_arn`: string<br>R `allowed_upload_origin`: string<br>R `enable_intake_target`: bool (= `contains(keys(var.lambda_image_uris), "evidence-intake")`)<br>R `intake_dlq_arn`: string<br>O `intake_function_name`: string = `null`<br>O `intake_alias_arn`: string = `null`<br>O `quarantine_expiration_days`: number = `1`<br>O `evidence_expiration_days`: number = `365` | `quarantine_bucket_name`<br>`quarantine_bucket_arn`<br>`quarantine_bucket_regional_origin`: `https://<bucket>.s3.af-south-1.amazonaws.com`<br>`evidence_bucket_name`<br>`evidence_bucket_arn`<br>`guardduty_role_arn`<br>`malware_protection_plan_arn`<br>`scan_result_rule_arn` | ecs-service `disputes` (`QUARANTINE_BUCKET`; statement `s3:PutObject` on `${quarantine_bucket_arn}/*`, no GetObject); ecs-service `web` (`quarantine_bucket_regional_origin`→`UPLOAD_ORIGIN`); lambda-fn intake (`QUARANTINE_BUCKET`, `EVIDENCE_BUCKET`; statements in §5); messaging (`scan_result_rule_arn`); ci-roles e2e (both bucket ARNs, read-only checks) |
| `lambda-fn` (×3) | One arm64 image function `cd-<key>` (`ignore_changes = [image_uri]`), alias `live`, role, VPC config, log group, optional SQS ESM (`ReportBatchItemFailures`), optional EventBridge Scheduler schedule (+ Scheduler role, DLQ target, retry), optional async config. Role, log group and Scheduler role always exist (phase A, §1); function-level resources need `image_uri`. | R `name_prefix`: string<br>R `function_key`: string<br>R `permissions_boundary_arn`: string<br>R `iam_path`: string<br>R `log_retention_days`: number<br>R `logs_kms_key_arn`: string<br>R `timeout_seconds`: number<br>R `subnet_ids`: list(string)<br>R `security_group_id`: string<br>R `data_kms_key_arn`: string<br>O `image_uri`: string = `null` (null = phase A, no function)<br>O `memory_mb`: number = `256`<br>O `environment`: map(string) = `{}`<br>O `policy_statements`: `<stmt>` = `[]`<br>O `sqs_event_source`: object({ queue_arn = string, batch_size = optional(number, 10) }) = `null`<br>O `schedule`: object({ expression = string, timezone = string, dlq_arn = string }) = `null`<br>O `schedule_max_retries`: number = `2`<br>O `async_on_failure_arn`: string = `null`<br>O `async_max_retries`: number = `2` | `function_name`: `cd-<key>`, `null` when `image_uri` is null<br>`function_arn`: same null rule<br>`alias_name`: `live`, same null rule<br>`alias_arn`: same null rule<br>`role_arn`: always set<br>`role_name`: always set<br>`log_group_name`: `/aws/lambda/cd-<key>`<br>`scheduler_role_arn`: Scheduler execution role, `null` when `schedule` is null | evidence-buckets (intake `function_name`, `alias_arn`); messaging (notifier `role_arn` → `allowed_consumer_role_arns`; intake `role_arn` → `evidence_intake_role_arns`; sweeper `scheduler_role_arn` → `retention_scheduler_role_arns`); observability (`function_name`s of created functions) |
| `ses` | Email identity `ses_sender` (sandbox), configuration set (default on the identity) → EventBridge → SQS `cd-ses-events` (short retention, SSE-KMS `data`) for E-03 delivery checks. | R `name_prefix`: string<br>R `sender_email`: string<br>R `kms_key_arn`: string<br>O `events_retention_seconds`: number = `86400` | `email_identity_arn`<br>`configuration_set_name`<br>`configuration_set_arn`<br>`ses_events_queue_url`<br>`ses_events_queue_arn` | lambda-fn notifier (`SES_SENDER`; statement `ses:SendEmail` on `[email_identity_arn, configuration_set_arn]` with `StringEquals ses:FromAddress = [sender_email]`); ci-roles e2e (`ses_events_queue_arn`) |
| `observability` | SNS `cd-alarms` (email, KMS `data`), dashboard `cd-dev`, alarms (DLQ depth ≥ 1 per DLQ; Lambda errors/throttles; `RetentionFailed`, `EventPublishFailed` for every `eventType`, `EvidenceNotScanned`, `EvidenceResultConflict`; ALB 5xx, p95 > 1 s, unhealthy hosts; Aurora at max ACU 15 min), explicit `treat_missing_data`; budget (forecast 100 %, actual 80 %/100 %, email subscriber). | R `name_prefix`: string<br>R `alert_email`: string<br>R `budget_usd`: number<br>R `kms_key_arn`: string<br>R `dlq_names`: map(string)<br>R `alb_arn_suffix`: string<br>R `target_group_arn_suffixes`: map(string)<br>R `aurora_cluster_identifier`: string<br>R `aurora_max_acu`: number<br>O `lambda_function_names`: map(string) = `{}` (only created functions) | `alarm_topic_arn`<br>`dashboard_name`: `cd-dev`<br>`budget_name`<br>`alarm_arns`: map(string), alarm key → alarm ARN | root outputs only |
| `ci-roles` | OIDC roles for pipelines: `publish-<repo key>` ×9 (sub `ref:refs/heads/main`, push to own repo only), `deploy-<svc>` ×5 (sub `environment:dev`, own service + own families, PassRole own task/exec roles), `deploy-lambda-<key>` ×3 (environment dev, own function + alias), `run-tools` (RunTask on tool families, PassRole tool roles), `e2e` (AdminInitiateAuth on the pool, read seed-user secrets, receive/delete `cd-ses-events`, read-only listings, Reachability Analyzer, net-probe RunTask). Audience `sts.amazonaws.com`, exact `sub` (never `*`). No role can call `iam:*` or touch another deployable. Lambda ARNs and net-probe roles are built from names, so the roles exist before the functions (phase A). | R `name_prefix`: string<br>R `permissions_boundary_arn`: string<br>R `iam_path`: string<br>R `github_repo`: string<br>R `github_oidc_provider_arn`: string<br>R `ecr_repository_arns`: map(string)<br>R `ecs_cluster_arn`: string<br>R `ecs_deployables`: map(object({ service_arn = string, task_definition_families = list(string), pass_role_arns = list(string) })) (service keys)<br>R `lambda_function_names`: map(string) (all three Lambda keys)<br>R `dev_tools`: object({ task_definition_families = list(string), pass_role_arns = list(string) })<br>R `cognito_user_pool_arn`: string<br>R `seed_user_secret_name_prefix`: string (`cd/dev/seed-users/`)<br>R `ses_events_queue_arn`: string<br>R `evidence_bucket_arns`: list(string)<br>R `data_kms_key_arn`: string | `role_arns`: map(string), keys `publish-<repo key>`, `deploy-<svc>`, `deploy-lambda-<key>`, `run-tools`, `e2e` | root outputs → GitHub Environment `dev` variables (runbook) |
| `dev-tools` | Task definitions `cd-db-bootstrap` (`DB_ADMIN_HOST/_PORT/_NAME` plain, `DB_ADMIN_USER/_PASSWORD` from master secret keys, `DB_PASSWORD_<ROLE>` from role secrets), `cd-dev-seed` (migrator URLs, Cognito admin on the pool, create/put seed-user secrets), `cd-net-probe` (in-VPC V-10 checks); per-task task + execution roles; one log group per task. | R `name_prefix`: string<br>R `permissions_boundary_arn`: string<br>R `iam_path`: string<br>R `log_retention_days`: number<br>R `logs_kms_key_arn`: string<br>R `cluster_arn`: string<br>R `image_uri`: string<br>R `subnet_ids`: list(string)<br>R `security_group_id`: string<br>R `data_kms_key_arn`: string<br>R `aurora`: object({ endpoint = string, port = number, database_name = string, master_secret_arn = string, role_secret_arns = map(string) })<br>R `cognito_user_pool_arn`: string<br>R `cognito_user_pool_id`: string<br>R `seed_user_secret_name_prefix`: string<br>O `probe_environment`: map(string) = `{}`<br>O `probe_secrets`: `<secret_ref>` = `{}`<br>O `probe_seed_username`: string = `"thandi.nkosi"` | `task_definition_families`: map(string), tool key → family<br>`task_definition_arns`: map(string)<br>`task_role_arns`: map(string); `db-bootstrap` has none and is absent<br>`execution_role_arns`: map(string), per task<br>`log_group_names`: map(string)<br>`run_task_network`: cluster, private subnets and dev-tools SG for RunTask (no public IP) | ci-roles (`dev_tools.task_definition_families`, `pass_role_arns = concat(values(task_role_arns), values(execution_role_arns))`); runbook / dev-tools pipeline (`run_task_network`) |

## 5. Wiring order, cycle notes and I-WIRE hand-offs

```
network → security → { ecr, ecs-cluster, aurora, messaging, ses, alb }
alb → edge → { cognito (callback URLs), evidence-buckets (CORS) }
{ cognito, aurora, alb, messaging, evidence-buckets, ses } → ecs-service ×5, lambda-fn ×3, dev-tools
{ ecs-service, lambda-fn, dev-tools, ecr, ecs-cluster } → ci-roles, observability
```
These module-level loops are safe because each closes at a separate resource:
- `messaging.allowed_consumer_role_arns` ← notifier role, while the notifier ESM ← queue ARN (closes at `aws_sqs_queue_policy`).
- `messaging.evidence_scan_rule_arn` ← rule, while the rule target ← intake DLQ ARN (closes at the queue policy / `aws_cloudwatch_event_target`).
- `alb.origin_secret_header_value` → edge, while edge → `alb_dns_name` (separate resources).

Service URLs: peers `http://<svc>:8081` (Service Connect); Lambdas `alb.service_port_base_url` in vpc_origin,
`http://<svc>.cd.internal:8081` in public_alb.
ECS autoscaling targets are registered only when `var.enable_service_autoscaling = true` (after the first deploy), passed
to each `ecs-service` as `enable_autoscaling`. Otherwise registering min 1 would start tasks before any image exists.

### I-WIRE hand-off checklist
- **Providers.** `edge` needs both `aws` and `aws.us_east_1`: `providers = { aws = aws, aws.us_east_1 = aws.us_east_1 }`.
- **Origin secret.** In `public_alb` mode pass `alb.origin_secret_header_value` to `edge.origin_secret_header_value`; in
  `vpc_origin` leave it `null`.
- **Sweeper retries.** The sweeper `lambda-fn` is invoked by the Scheduler, which already retries
  (`schedule_max_retries`): set `async_max_retries = 0` for `retention-sweeper`.
- **No `AWS_REGION`.** Never put `AWS_REGION` in a Lambda `environment` (reserved key; the runtime sets it).
- **Messaging role lists.** `allowed_sender_role_arns`, `allowed_consumer_role_arns`, `evidence_intake_role_arns` and
  `retention_scheduler_role_arns` must be non-empty (an empty list would make the allow-list Deny refuse every
  producer). Pass the always-present roles (they exist in phase A even with no image): sender =
  `ecs-service.disputes.task_role_arn`; consumer = `lambda-fn.dispute-notifier.role_arn`;
  `evidence_intake_role_arns = [lambda-fn.evidence-intake.role_arn]`;
  `retention_scheduler_role_arns = [lambda-fn.retention-sweeper.scheduler_role_arn]` (the sweeper always has a
  `schedule`, so it is never null). Optionally `redrive_operator_arns` (the operator role, if any). Sending roles (disputes task, intake, Scheduler role) also need
  `kms:GenerateDataKey` / `kms:Decrypt` on `cd-data` in their own policies.
- **Intake role statements** (`lambda-fn.evidence-intake.policy_statements`): `s3:GetObject` (+ `DeleteObject`) on
  `${quarantine_bucket_arn}/*`; `s3:PutObject` on `${evidence_bucket_arn}/evidence/*`;
  `kms:Decrypt` + `kms:GenerateDataKey` on `kms_key_arns["evidence"]`. Plus the `svc-evidence-intake` token secret and
  the queue send to `evidence_intake_dlq_arn`.
- **Notifier statements.** `sqs` receive/delete on `notifications_queue_arn`, `ses:SendEmail` as in the `ses` row,
  token secret read.
- **Sweeper.** `schedule = { expression, timezone, dlq_arn = messaging.retention_scheduler_dlq_arn }`; DB secret
  `role_secret_arns["disputes_retention"]`.
- **Aurora logs key.** `aurora.logs_kms_key_arn` is required: pass `kms_key_arns["data"]` (log group encryption).
- **Backend init.** `terraform init` for `envs/dev` needs `-backend-config="kms_key_id=<state_kms_key_arn>"` along with
  `bucket`, `key` and `region`; without it the S3 backend sends AES256 and the bucket policy rejects the write.
- **Lambda environment key.** `lambda-fn` sets no `kms_key_arn`: environments hold only ids and secret references and
  use the AWS-managed Lambda key, because `cd-data` admits no Lambda `ViaService`.
- **net-probe runs twice** (ADR-067): once with the `dev-tools` SG (expects refusals), once with the `dispute-notifier`
  SG (expects `403`/`401` as specified), because the SG matrix is not widened for tooling. The second run overrides
  the task's network configuration at RunTask.
- **No `--tags` on RunTask.** Pipelines must not pass `--tags` or `--propagate-tags` (roles have no `ecs:TagResource`).
- **Tool names.** Keep the `cd-<tool>-task` / `-exec` role and `cd-<tool>` family names (§1); ci-roles builds the
  net-probe pair from them.
- **dev-tools environment names (X-01 implements these in `local/seed`):** `MIGRATOR_DATABASE_URL_<SCHEMA>` (one per
  schema), `SEED_USER_SECRET_PREFIX`, `SEED_USER_SECRET_KMS_KEY_ID`; with `SEED_TARGET=aws` skip `bootstrap()`;
  `CreateSecret` with that `KmsKeyId` and **no tags**.
- **Fixed-key inputs.** `ci-roles.lambda_function_names` carries all three Lambda keys even when a function has no
  image; `observability.lambda_function_names` carries only created functions.
