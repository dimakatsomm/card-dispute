mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "af-south-1", name = "af-south-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:af-south-1:123456789012:log-group:/cd/dev/tools/tool" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/cd/cd-tool-role" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:af-south-1:123456789012:task-definition/cd-tool:1" }
  }
}

variables {
  name_prefix              = "cd"
  permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cd-workload-boundary"
  iam_path                 = "/cd/"
  log_retention_days       = 7
  logs_kms_key_arn         = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  data_kms_key_arn         = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  cluster_arn              = "arn:aws:ecs:af-south-1:123456789012:cluster/cd"
  image_uri                = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-dev-tools:initial"
  subnet_ids               = ["subnet-private-a", "subnet-private-b"]
  security_group_id        = "sg-dev-tools"
  aurora = {
    endpoint          = "cd-aurora.cluster-abc.af-south-1.rds.amazonaws.com"
    port              = 5432
    database_name     = "disputes"
    master_secret_arn = "arn:aws:secretsmanager:af-south-1:123456789012:secret:rds!cluster-0000-AbCdEf"
    role_secret_arns = {
      auth_migrator         = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/auth_migrator-A1b2C3"
      auth_app              = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/auth_app-A1b2C3"
      users_migrator        = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/users_migrator-A1b2C3"
      users_app             = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/users_app-A1b2C3"
      transactions_migrator = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/transactions_migrator-A1b2C3"
      transactions_app      = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/transactions_app-A1b2C3"
      disputes_migrator     = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_migrator-A1b2C3"
      disputes_app          = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_app-A1b2C3"
      disputes_retention    = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_retention-A1b2C3"
    }
  }
  cognito_user_pool_arn        = "arn:aws:cognito-idp:af-south-1:123456789012:userpool/af-south-1_AbCdEfGhI"
  cognito_user_pool_id         = "af-south-1_AbCdEfGhI"
  seed_user_secret_name_prefix = "cd/dev/seed-users/"
  probe_environment = {
    SERVICE_PORT_BASE_URL = "http://internal-cd-alb-123.af-south-1.elb.amazonaws.com:8081"
    TOKEN_URL             = "https://cd-dev.auth.af-south-1.amazoncognito.com/oauth2/token"
    E2E_CLIENT_ID         = "e2eclientid"
    SERVICE_CLIENT_ID     = "notifierclientid"
  }
  probe_secrets = {
    SERVICE_CLIENT_SECRET = { secret_arn = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-notifier-GhIjKl" }
  }
}

run "containers_are_hardened_arm64" {
  command = apply

  assert {
    condition = alltrue([for k, td in aws_ecs_task_definition.this :
      jsondecode(td.container_definitions)[0].readonlyRootFilesystem == true &&
      one([for m in jsondecode(td.container_definitions)[0].mountPoints : m.containerPath if m.sourceVolume == "tmp"]) == "/tmp" &&
      one(td.volume).name == "tmp"
    ])
    error_message = "Every tool container must have a read-only root and a /tmp volume."
  }

  assert {
    condition = alltrue([for k, td in aws_ecs_task_definition.this :
      jsondecode(td.container_definitions)[0].user == "1000:1000" &&
      jsondecode(td.container_definitions)[0].privileged == false &&
      jsondecode(td.container_definitions)[0].linuxParameters.capabilities.drop == ["ALL"]
    ])
    error_message = "Every tool container must run as the non-root node user with all capabilities dropped."
  }

  assert {
    condition = alltrue([for k, td in aws_ecs_task_definition.this :
      one(td.runtime_platform).cpu_architecture == "ARM64" && td.network_mode == "awsvpc" &&
      td.cpu == "256" && td.memory == "512" && td.requires_compatibilities == toset(["FARGATE"])
    ])
    error_message = "Every tool runs on Fargate ARM64, awsvpc, 0.25 vCPU / 0.5 GB."
  }

  assert {
    condition = (
      { for k, td in aws_ecs_task_definition.this : k => jsondecode(td.container_definitions)[0].command } ==
      { db-bootstrap = ["bootstrap"], dev-seed = ["seed"], net-probe = ["probe"] }
    )
    error_message = "Commands must be bootstrap, seed and probe."
  }

  assert {
    condition = (
      output.task_definition_families == { db-bootstrap = "cd-db-bootstrap", dev-seed = "cd-dev-seed", net-probe = "cd-net-probe" } &&
      output.log_group_names == { db-bootstrap = "/cd/dev/tools/db-bootstrap", dev-seed = "/cd/dev/tools/dev-seed", net-probe = "/cd/dev/tools/net-probe" }
    )
    error_message = "Families and log groups must follow the naming contract."
  }

  assert {
    condition = alltrue([for lg in aws_cloudwatch_log_group.this :
      lg.kms_key_id == var.logs_kms_key_arn && lg.retention_in_days == 7
    ])
    error_message = "Tool log groups must be KMS-encrypted with retention."
  }
}

run "bootstrap_gets_admin_parts_and_nine_role_passwords" {
  command = plan

  assert {
    condition = (
      { for s in jsondecode(aws_ecs_task_definition.this["db-bootstrap"].container_definitions)[0].secrets : s.name => s.valueFrom } ==
      merge(
        {
          DB_ADMIN_USER     = "${var.aurora.master_secret_arn}:username::"
          DB_ADMIN_PASSWORD = "${var.aurora.master_secret_arn}:password::"
        },
        { for role, arn in var.aurora.role_secret_arns : "DB_PASSWORD_${upper(role)}" => "${arn}:password::" },
      )
    )
    error_message = "bootstrap secrets must be the master username/password and all nine DB_PASSWORD_<ROLE> from each role secret's password key."
  }

  assert {
    condition     = length([for s in jsondecode(aws_ecs_task_definition.this["db-bootstrap"].container_definitions)[0].secrets : s if startswith(s.name, "DB_PASSWORD_")]) == 9
    error_message = "bootstrap must get exactly nine DB_PASSWORD_* secrets."
  }

  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.this["db-bootstrap"].container_definitions)[0].environment : e.name => e.value } ==
      { DB_ADMIN_HOST = var.aurora.endpoint, DB_ADMIN_PORT = "5432", DB_ADMIN_NAME = "disputes", LOG_LEVEL = "info" }
    )
    error_message = "bootstrap env must be the plain admin host/port/name and no DB_ADMIN_SSL (defaults to verify-full)."
  }

  assert {
    condition     = aws_ecs_task_definition.this["db-bootstrap"].task_role_arn == null && !contains(keys(output.task_role_arns), "db-bootstrap")
    error_message = "bootstrap must have no task role."
  }
}

run "seed_uses_migrator_urls_and_cognito_env" {
  command = plan

  assert {
    condition = (
      { for s in jsondecode(aws_ecs_task_definition.this["dev-seed"].container_definitions)[0].secrets : s.name => s.valueFrom } ==
      { for schema in ["auth", "users", "transactions", "disputes"] : "MIGRATOR_DATABASE_URL_${upper(schema)}" => "${var.aurora.role_secret_arns["${schema}_migrator"]}:url::" }
    )
    error_message = "seed secrets must be exactly the four migrator url keys."
  }

  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.this["dev-seed"].container_definitions)[0].environment : e.name => e.value }["SEED_TARGET"] == "aws" &&
      { for e in jsondecode(aws_ecs_task_definition.this["dev-seed"].container_definitions)[0].environment : e.name => e.value }["COGNITO_USER_POOL_ID"] == var.cognito_user_pool_id &&
      { for e in jsondecode(aws_ecs_task_definition.this["dev-seed"].container_definitions)[0].environment : e.name => e.value }["AWS_REGION"] == "af-south-1"
    )
    error_message = "seed must run with SEED_TARGET=aws, AWS_REGION and the pool id."
  }
}

run "cognito_permissions_scoped_to_pool" {
  command = apply

  assert {
    condition = alltrue(flatten([for p in aws_iam_role_policy.task : [
      for s in jsondecode(p.policy).Statement : s.Resource == [var.cognito_user_pool_arn]
      if anytrue([for a in s.Action : startswith(a, "cognito-idp:")])
    ]]))
    error_message = "Every cognito-idp statement must have the pool ARN as its only resource."
  }

  assert {
    condition = toset(one([for s in jsondecode(aws_iam_role_policy.task["dev-seed"].policy).Statement : s.Action if s.Sid == "SeedCognitoUsersInPool"])) == toset([
      "cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminGetUser",
      "cognito-idp:AdminDisableUser", "cognito-idp:ListUsers",
    ])
    error_message = "seed gets exactly the five admin actions."
  }

  assert {
    condition = (
      [for s in jsondecode(aws_iam_role_policy.task["net-probe"].policy).Statement : s.Action if s.Sid == "UserTokenViaE2eClient"] ==
      [["cognito-idp:AdminInitiateAuth"]]
    )
    error_message = "probe may only AdminInitiateAuth."
  }
}

run "secrets_access_limited_to_referenced_arns" {
  command = apply

  assert {
    condition = (
      toset(one([for s in jsondecode(aws_iam_role_policy.execution["db-bootstrap"].policy).Statement : s.Resource if s.Sid == "ReadReferencedSecrets"])) ==
      toset(concat([var.aurora.master_secret_arn], values(var.aurora.role_secret_arns)))
    )
    error_message = "bootstrap execution role reads only the master secret and the nine role secrets."
  }

  assert {
    condition = (
      toset(one([for s in jsondecode(aws_iam_role_policy.execution["dev-seed"].policy).Statement : s.Resource if s.Sid == "ReadReferencedSecrets"])) ==
      toset([for r in ["auth_migrator", "users_migrator", "transactions_migrator", "disputes_migrator"] : var.aurora.role_secret_arns[r]])
    )
    error_message = "seed execution role reads only the four migrator secrets."
  }

  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.execution["net-probe"].policy).Statement : s.Resource if s.Sid == "ReadReferencedSecrets"]) ==
      [var.probe_secrets.SERVICE_CLIENT_SECRET.secret_arn]
    )
    error_message = "probe execution role reads only the svc-notifier client secret."
  }

  assert {
    condition = alltrue(flatten([for p in aws_iam_role_policy.execution : [
      for s in jsondecode(p.policy).Statement : s.Condition.StringEquals["kms:ViaService"] == "secretsmanager.af-south-1.amazonaws.com"
      if contains(s.Action, "kms:Decrypt")
    ]]))
    error_message = "Execution roles decrypt only via Secrets Manager."
  }

  assert {
    condition = alltrue(flatten([for p in aws_iam_role_policy.task : [
      for s in jsondecode(p.policy).Statement : alltrue([
        for r in s.Resource : startswith(r, "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/seed-users/")
      ]) if anytrue([for a in s.Action : startswith(a, "secretsmanager:")])
    ]]))
    error_message = "Task roles touch only seed-user secrets."
  }

  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.task["dev-seed"].policy).Statement : s.Condition.StringEquals["secretsmanager:KmsKeyId"] if s.Sid == "CreateSeedUserSecretsWithDataKey"]) == var.data_kms_key_arn
    )
    error_message = "seed may only create secrets encrypted with cd-data."
  }

  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.task["net-probe"].policy).Statement : s.Resource if s.Sid == "ReadProbeUserPassword"]) == ["arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/seed-users/thandi.nkosi-??????"]
    error_message = "probe reads only persona A's seed-user secret."
  }
}

run "no_wildcards_except_documented" {
  command = apply

  assert {
    condition = alltrue(flatten([for p in concat(values(aws_iam_role_policy.execution), values(aws_iam_role_policy.task)) : [
      for s in jsondecode(p.policy).Statement : [for a in s.Action : a != "*" && !endswith(a, ":*")]
    ]]))
    error_message = "No * or service:* actions."
  }

  assert {
    condition = alltrue(flatten([for p in concat(values(aws_iam_role_policy.execution), values(aws_iam_role_policy.task)) : [
      for s in jsondecode(p.policy).Statement : s.Action == ["ecr:GetAuthorizationToken"] if contains(s.Resource, "*")
    ]]))
    error_message = "Resource * is allowed only for ecr:GetAuthorizationToken."
  }

  assert {
    condition = alltrue(flatten([for p in concat(values(aws_iam_role_policy.execution), values(aws_iam_role_policy.task)) : [
      for s in jsondecode(p.policy).Statement : [for r in s.Resource : r == "*" || !endswith(r, "*") || r == "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/seed-users/*" || endswith(r, ":log-stream:*")]
    ]]))
    error_message = "Partial wildcards are only the seed-user prefix and own log streams."
  }

  assert {
    condition = alltrue([for r in concat(values(aws_iam_role.execution), values(aws_iam_role.task)) :
      r.path == "/cd/" && r.permissions_boundary == var.permissions_boundary_arn
    ])
    error_message = "All roles use path /cd/ and the workload boundary."
  }
}

run "probe_env_rejects_secrets" {
  command = plan

  variables {
    probe_environment = { SERVICE_CLIENT_SECRET = "oops" }
  }

  expect_failures = [var.probe_environment]
}

run "image_must_be_dev_tools_repo" {
  command = plan

  variables {
    image_uri = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-svc-disputes:initial"
  }

  expect_failures = [var.image_uri]
}
