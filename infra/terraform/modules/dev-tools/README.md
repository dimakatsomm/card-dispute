# dev-tools

One-shot Fargate task definitions on the `dev-tools` image (ADR-061), run with `RunTask` by the dev-tools
pipeline (CI-02e). No ECS service. Interface: `../README.md` §4 (`dev-tools` row).

Every task: ARM64, awsvpc, 0.25 vCPU / 0.5 GB, user `1000:1000`, read-only root + `tmp` volume at `/tmp`,
all capabilities dropped, awslogs to `/cd/dev/tools/<tool>` (KMS, retention). Roles use `iam_path` and the
boundary. Each tool has its own execution role: ECR pull on `cd-dev-tools`, its own log group, `GetSecretValue`
on exactly the secrets it references, `kms:Decrypt` via Secrets Manager.

## Env and secrets per task

| Family | Command | Environment | Secrets (`valueFrom`) | Task role |
|---|---|---|---|---|
| `cd-db-bootstrap` | `bootstrap` | `DB_ADMIN_HOST`, `DB_ADMIN_PORT`, `DB_ADMIN_NAME`, `LOG_LEVEL`; no `DB_ADMIN_SSL` (verify-full) | `DB_ADMIN_USER` = master `:username::`, `DB_ADMIN_PASSWORD` = master `:password::`, `DB_PASSWORD_<ROLE>` = `cd/dev/db/<role>` `:password::` ×9 | none |
| `cd-dev-seed` | `seed` | `SEED_TARGET=aws`, `AWS_REGION`, `COGNITO_USER_POOL_ID`, `SEED_USER_SECRET_PREFIX`, `SEED_USER_SECRET_KMS_KEY_ID` (cd-data ARN), `DB_HOST`, `DB_PORT`, `DB_NAME`, `LOG_LEVEL` | `MIGRATOR_DATABASE_URL_{AUTH,USERS,TRANSACTIONS,DISPUTES}` = `cd/dev/db/<schema>_migrator` `:url::` | Cognito admin actions on the pool; Create (only with `KmsKeyId` = cd-data ARN) / Put / Describe / Get on `cd/dev/seed-users/*`; GenerateDataKey/Decrypt on cd-data via Secrets Manager for those secrets |
| `cd-net-probe` | `probe` | `AWS_REGION`, `COGNITO_USER_POOL_ID`, `PROBE_USER_SECRET_ID`, `LOG_LEVEL` + `probe_environment` (`SERVICE_PORT_BASE_URL`, `TOKEN_URL`, `E2E_CLIENT_ID`, `SERVICE_CLIENT_ID`) | `probe_secrets` (`SERVICE_CLIENT_SECRET` = svc-notifier) | `AdminInitiateAuth` on the pool; `GetSecretValue` on persona A's seed-user secret only |

dev-seed must create secrets with `KmsKeyId` set to the exact cd-data key ARN it receives and without tags.
The probe gets its user token with `AdminInitiateAuth` (`ADMIN_USER_PASSWORD_AUTH`) on the e2e client, using the
password in `PROBE_USER_SECRET_ID`, and its service token with client_credentials as svc-notifier.

`run_task_network` passes the cluster, private subnets and dev-tools SG through for `RunTask`.
