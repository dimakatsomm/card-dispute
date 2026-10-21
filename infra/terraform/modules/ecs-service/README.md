# ecs-service

One Fargate service (`cd-<svc>`) with its task definition, optional one-shot migrate task definition
(`cd-<svc>-migrate`), log group, task role and execution role. I-WIRE instantiates it once per service key.
Interface: `../README.md` §4 (`ecs-service` row).

## What it creates

| Resource | Notes |
|---|---|
| Task definition `cd-<svc>` | ARM64, awsvpc, `readonlyRootFilesystem`, ephemeral `tmp` volume at `/tmp`, user `1000:1000` (image `USER node`) or `101:101` for web (nginx-unprivileged), not privileged, all Linux capabilities dropped, awslogs (non-blocking) to `/cd/dev/ecs/<svc>`, container health check `wget http://127.0.0.1:8080<health_check_path>`: liveness `/health` (backend) or `/healthz` (web), never `/ready`, so a DB pause drains ALB traffic (target groups check `/ready`, I-08) instead of making ECS restart healthy tasks. `skip_destroy` keeps old revisions for rollback. |
| Task definition `cd-<svc>-migrate` | Only when `migrate != null`. Same image and hardening, `command = migrate.command` (`["migrate"]`), env `migrate.environment` + `LOG_LEVEL=info`, secrets `migrate.secrets` (`MIGRATOR_DATABASE_URL` = migrator secret key `url`). No task role (migrations need no AWS API). The pipeline runs it with `RunTask`. |
| ECS service `cd-<svc>` | `desired_count` 0, `ignore_changes = [task_definition, desired_count]` (the pipeline owns both), circuit breaker with rollback, no public IP, no ECS Exec. ALB attachments from `target_groups` (`"8080"`; `"8081"` only for users and disputes). |
| Service Connect | `service_connect_server = true`: port `service` (8081) published as `<svc>:8081`; server mode includes client mode, so backend services also resolve `auth:8081` and their peers. web: no Service Connect (it calls nobody). |
| Cloud Map DNS service `<svc>` | Only when `register_cloud_map_service` (public_alb fallback, users/disputes). The Service Connect discovery name then becomes `<svc>-sc` because Cloud Map service names are unique per namespace; peers still use `http://<svc>:8081`. |
| Autoscaling | Only when `enable_autoscaling`: target 1–2 tasks, target tracking on `ECSServiceAverageCPUUtilization` 60 %. |
| Execution role `cd-<svc>-exec` | `ecr:GetAuthorizationToken` on `*` (no resource-level permission), pull on the image's own repository, `CreateLogStream`/`PutLogEvents` on its log group, `secretsmanager:GetSecretValue` on exactly the ARNs in `secrets` + `migrate.secrets`, `kms:Decrypt` on cd-data via Secrets Manager only. |
| Task role `cd-<svc>-task` | Policy = `task_role_statements` (jsonencoded, null `Condition` dropped); no policy when empty. Statements with `*` or `service:*` are rejected by validation. |

Both roles use `iam_path` and `permissions_boundary_arn`.

## Environment defaults

The module merges `environment` over these defaults (caller wins):

| Service | Defaults |
|---|---|
| all backend | `PUBLIC_PORT=8080`, `SERVICE_PORT=8081`, `LOG_LEVEL=info`, `DB_POOL_MAX=5` |
| users | + `AUTH_URL=http://auth:8081` |
| transactions | + `AUTH_URL`, `USERS_SERVICE_URL=http://users:8081`, `DISPUTES_SERVICE_URL=http://disputes:8081` |
| disputes | + `AUTH_URL`, `USERS_SERVICE_URL`, `TRANSACTIONS_SERVICE_URL=http://transactions:8081`, `AWS_REGION` (current region) |
| web | `API_BASE=/api` |

The caller still supplies (from `../README.md` §4): auth `AUTH_ISSUER_URL`, `AUTH_JWKS_URI`,
`AUTH_USER_CLIENT_IDS`, `AUTH_SERVICE_CLIENT_IDS`; users/transactions/disputes `TOKEN_URL`, `SERVICE_CLIENT_ID`;
disputes `QUARANTINE_BUCKET`, `NOTIFICATIONS_QUEUE_URL`; web `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`,
`OIDC_LOGOUT_URL`, `OIDC_POST_LOGOUT_URI`, `UPLOAD_ORIGIN`, `OIDC_TOKEN_ORIGIN` (validated present).
Secrets: `DATABASE_URL` (`<svc>_app` key `url`), `SERVICE_CLIENT_SECRET` (raw string, no `json_key`).

Validation rejects `AUTH_ALLOW_INSECURE_JWKS` (local compose only) and `DATABASE_URL`, `MIGRATOR_DATABASE_URL`,
`SERVICE_CLIENT_SECRET` as plain environment.

## Inputs beyond the contract row

Optional, defaulted: `desired_count` (0), `autoscaling_min_capacity` (1), `autoscaling_max_capacity` (2),
`autoscaling_cpu_target` (60). `cpu`/`memory` default to 256/512 (ADR-065).

## Validated only after deploy [R]

- Non-root writes to the Fargate bind mount at `/tmp` (the image's `/tmp` is 1777).
- Service Connect proxy headroom at 0.25 vCPU / 0.5 GB (ADR-065).
- Service Connect and a Cloud Map DNS registry on the same service (public_alb fallback only).
