# lambda-fn

One container-image Lambda `cd-<key>` with its role, log group, alias `live` and optional triggers. I-WIRE
instantiates it for every Lambda key with `image_uri = lookup(var.lambda_image_uris, key, null)`.
Interface: `../README.md` §4 (`lambda-fn` row).

## Phase A / phase B

| Always (phase A, `image_uri = null`) | Only when `image_uri != null` (phase B) |
|---|---|
| Role `cd-<key>-role` (+ policy), log group `/aws/lambda/cd-<key>`, scheduler role `cd-<key>-scheduler` when `schedule != null` | Function, alias `live`, async invoke config, SQS event source mapping, schedule |

Queue policies in messaging name the notifier, intake and scheduler roles, and SQS rejects a policy that names a
role that does not exist yet. So `role_arn`, `role_name`, `log_group_name` and `scheduler_role_arn` are non-null
in phase A, and `function_name`, `function_arn`, `alias_name` and `alias_arn` are null until the image exists.
Conditionals use only plan-known values: `image_uri`, and the null-ness of `schedule` and `sqs_event_source`.
`async_on_failure_arn` only switches a dynamic block and a policy statement, never a `count`.

## What it creates

| Resource | Notes |
|---|---|
| Function | `package_type = "Image"`, arm64, `memory_mb` (256), `timeout_seconds`, `publish = true`, `ignore_changes = [image_uri]` (the pipeline owns code), tracing PassThrough (ADR-063), private subnets plus its own SG, env on the AWS-managed Lambda key (no secrets in it; cd-data admits no Lambda `ViaService`), logs to the pre-created group. No reserved concurrency (account quota, OWN-1). The image's `CMD ["index.handler"]` is used as is. |
| Alias `live` | `ignore_changes = [function_version]`; the deploy pipeline moves it. Every trigger targets the alias. |
| Async invoke config | On `live`: `async_max_retries` (2); on-failure destination `async_on_failure_arn` when set (intake: `cd-evidence-intake-dlq`). |
| SQS event source mapping | When `sqs_event_source != null`: on `live`, `batch_size` (10), `ReportBatchItemFailures`. |
| Schedule `cd-<key>` | When `schedule != null`: default group, flexible window off, target `live`, retry `schedule_max_retries` (2) / 1 h max age, DLQ `schedule.dlq_arn`. |
| Role `cd-<key>-role` | Module statements: logs on its own group; ENI actions on `*` (documented exception); `sqs:SendMessage` + KMS via SQS on the on-failure DLQ when set. Then `policy_statements`. |
| Scheduler role `cd-<key>-scheduler` | Trust `scheduler.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` = the schedule; `lambda:InvokeFunction` on the `live` alias ARN (built from names), `sqs:SendMessage` on the schedule DLQ, KMS via SQS. |

## Environment

Defaults (the caller wins): all `LOG_LEVEL=info`; intake `EVIDENCE_REQUIRE_SCAN=true`; sweeper `DB_SSL=true`,
`METRICS_NAMESPACE=cd/retention-sweeper`. Secrets are references: intake `SERVICE_CLIENT_SECRET_ID`, notifier
`SERVICE_CLIENT_SECRET_ARN`, sweeper `DATABASE_SECRET_ID`. Validation rejects `EVIDENCE_REQUIRE_SCAN` other than
`true`, `DB_SSL` other than `true`, any key ending `_SECRET`, `DATABASE_URL`, `AWS_ENDPOINT_URL`, `SES_ENDPOINT`,
and Lambda-reserved keys (`AWS_REGION`, `AWS_LAMBDA_*`, credentials, `_*`). Lambda sets `AWS_REGION` itself.

## Policy statements

Validation rejects `*` / `service:*` actions, `*` resources, reserved module Sids, and an `sqs_event_source`
without `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` in `policy_statements`.

`Condition` is `optional(map(map(list(string))))`: operator → key → list of values, single values included
(`{ StringEquals = { "ses:FromAddress" = [sender] } }`). Any mix of statements with and without a Condition
converts; a null Condition is not rendered.

## Inputs beyond the contract row

`schedule_max_retries` (2), plus the common `name_prefix`, `permissions_boundary_arn`, `iam_path`,
`log_retention_days`, `logs_kms_key_arn`. Output beyond the row: `scheduler_role_arn`.

## Not provable offline [R]

- The image pull: Lambda pulls with the deployer's ECR permissions (and an ECR repository policy for
  `lambda.amazonaws.com` if the deployer cannot set one); the execution role has no ECR access.
