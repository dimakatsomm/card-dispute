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
    defaults = { arn = "arn:aws:logs:af-south-1:123456789012:log-group:/cd/dev/ecs/disputes" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/cd/cd-disputes-role" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:af-south-1:123456789012:task-definition/cd-disputes:1" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:af-south-1:123456789012:service/srv-abc" }
  }
}

variables {
  name_prefix              = "cd"
  service_name             = "disputes"
  permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cd-workload-boundary"
  iam_path                 = "/cd/"
  log_retention_days       = 7
  logs_kms_key_arn         = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  data_kms_key_arn         = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  cluster_arn              = "arn:aws:ecs:af-south-1:123456789012:cluster/cd"
  namespace_arn            = "arn:aws:servicediscovery:af-south-1:123456789012:namespace/ns-abc"
  namespace_id             = "ns-abc"
  image_uri                = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-svc-disputes:initial"
  subnet_ids               = ["subnet-private-a", "subnet-private-b"]
  security_group_id        = "sg-disputes"
  service_connect_server   = true
  health_check_path        = "/health"
  target_groups = {
    "8080" = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-disputes-8080/abc", container_port = 8080 }
    "8081" = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-disputes-8081/def", container_port = 8081 }
  }
  environment = {
    QUARANTINE_BUCKET = "cd-dev-quarantine-123456789012"
  }
  secrets = {
    DATABASE_URL          = { secret_arn = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_app-AbCdEf", json_key = "url" }
    SERVICE_CLIENT_SECRET = { secret_arn = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-disputes-GhIjKl" }
  }
  migrate = {
    command     = ["migrate"]
    environment = {}
    secrets = {
      MIGRATOR_DATABASE_URL = { secret_arn = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_migrator-MnOpQr", json_key = "url" }
    }
  }
  task_role_statements = [{
    Sid      = "SendNotifications"
    Effect   = "Allow"
    Action   = ["sqs:SendMessage"]
    Resource = ["arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications"]
  }]
}

run "task_definition_is_hardened_arm64" {
  command = apply

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service.container_definitions)[0].readonlyRootFilesystem == true
    error_message = "The service container must have a read-only root filesystem."
  }

  assert {
    condition     = one([for m in jsondecode(aws_ecs_task_definition.service.container_definitions)[0].mountPoints : m.containerPath if m.sourceVolume == "tmp"]) == "/tmp" && one(aws_ecs_task_definition.service.volume).name == "tmp"
    error_message = "An ephemeral tmp volume must be mounted at /tmp."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service.container_definitions)[0].user == "1000:1000"
    error_message = "Backend containers must run as the image's node user (1000), never root."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service.container_definitions)[0].privileged == false
    error_message = "The container must not be privileged."
  }

  assert {
    condition     = one(aws_ecs_task_definition.service.runtime_platform).cpu_architecture == "ARM64"
    error_message = "The task must run on ARM64."
  }

  assert {
    condition     = aws_ecs_task_definition.service.network_mode == "awsvpc" && aws_ecs_task_definition.service.cpu == "256" && aws_ecs_task_definition.service.memory == "512"
    error_message = "awsvpc with the 0.25 vCPU / 0.5 GB default (ADR-065)."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service.container_definitions)[0].healthCheck.command[5] == "http://127.0.0.1:8080/health"
    error_message = "Backend container health check must hit the /health liveness route on 8080."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service.container_definitions)[0].logConfiguration.logDriver == "awslogs" && aws_cloudwatch_log_group.this.kms_key_id == var.logs_kms_key_arn && aws_cloudwatch_log_group.this.retention_in_days == 7 && aws_cloudwatch_log_group.this.name == "/cd/dev/ecs/disputes"
    error_message = "Logs go via awslogs to a KMS-encrypted /cd/dev/ecs/<svc> group with retention."
  }
}

run "environment_contract" {
  command = plan

  assert {
    condition = { for e in jsondecode(aws_ecs_task_definition.service.container_definitions)[0].environment : e.name => e.value } == {
      PUBLIC_PORT              = "8080"
      SERVICE_PORT             = "8081"
      LOG_LEVEL                = "info"
      DB_POOL_MAX              = "5"
      AUTH_URL                 = "http://auth:8081"
      USERS_SERVICE_URL        = "http://users:8081"
      TRANSACTIONS_SERVICE_URL = "http://transactions:8081"
      AWS_REGION               = "af-south-1"
      QUARANTINE_BUCKET        = "cd-dev-quarantine-123456789012"
    }
    error_message = "disputes env must be the documented defaults plus caller values."
  }

  assert {
    condition = { for s in jsondecode(aws_ecs_task_definition.service.container_definitions)[0].secrets : s.name => s.valueFrom } == {
      DATABASE_URL          = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_app-AbCdEf:url::"
      SERVICE_CLIENT_SECRET = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-disputes-GhIjKl"
    }
    error_message = "Secrets render as <arn>:<json_key>:: (or the bare ARN for raw-string secrets)."
  }
}

run "insecure_jwks_is_rejected" {
  command = plan

  variables {
    service_name  = "auth"
    target_groups = {}
    environment   = { AUTH_ALLOW_INSECURE_JWKS = "true" }
  }

  expect_failures = [var.environment]
}

run "service_is_parked_with_circuit_breaker" {
  command = apply

  assert {
    condition     = aws_ecs_service.this.desired_count == 0
    error_message = "desired_count must default to 0."
  }

  assert {
    condition     = one(aws_ecs_service.this.deployment_circuit_breaker).enable && one(aws_ecs_service.this.deployment_circuit_breaker).rollback
    error_message = "The deployment circuit breaker must be on with rollback."
  }

  assert {
    condition     = can(regex("lifecycle\\s*\\{\\s*ignore_changes\\s*=\\s*\\[task_definition,\\s*desired_count\\]", file("${path.module}/main.tf")))
    error_message = "aws_ecs_service must ignore_changes = [task_definition, desired_count]."
  }

  assert {
    condition     = one(aws_ecs_service.this.network_configuration).assign_public_ip == false
    error_message = "Tasks must not get public IPs."
  }

  assert {
    condition     = length(aws_appautoscaling_target.this) == 0 && length(aws_appautoscaling_policy.cpu) == 0
    error_message = "Autoscaling is off by default."
  }
}

run "service_connect_server_alias" {
  command = plan

  assert {
    condition = (
      one(aws_ecs_service.this.service_connect_configuration).enabled &&
      one(one(aws_ecs_service.this.service_connect_configuration).service).port_name == "service" &&
      one(one(aws_ecs_service.this.service_connect_configuration).service).discovery_name == "disputes" &&
      one(one(one(aws_ecs_service.this.service_connect_configuration).service).client_alias).dns_name == "disputes" &&
      one(one(one(aws_ecs_service.this.service_connect_configuration).service).client_alias).port == 8081
    )
    error_message = "Service Connect must publish disputes:8081."
  }
}

run "execution_role_reads_only_given_secrets" {
  command = apply

  assert {
    condition = toset(one([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if s.Sid == "ReadOwnSecrets"])) == toset([
      "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_app-AbCdEf",
      "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-disputes-GhIjKl",
      "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_migrator-MnOpQr",
    ])
    error_message = "GetSecretValue must be scoped to exactly the service and migrate secret ARNs."
  }

  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement :
      alltrue([for a in s.Action : a != "*" && !endswith(a, ":*")]) &&
      (s.Sid == "EcrAuthToken" || !contains(s.Resource, "*"))
    ])
    error_message = "No * action anywhere; Resource * only on ecr:GetAuthorizationToken."
  }

  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Action if s.Sid == "EcrAuthToken"]) == ["ecr:GetAuthorizationToken"]
    error_message = "The only Resource * statement must carry only ecr:GetAuthorizationToken."
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s if s.Sid == "DecryptSecretsWithDataKey"]) == {
      Sid       = "DecryptSecretsWithDataKey"
      Effect    = "Allow"
      Action    = ["kms:Decrypt"]
      Resource  = [var.data_kms_key_arn]
      Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.af-south-1.amazonaws.com" } }
    }
    error_message = "kms:Decrypt only on cd-data via Secrets Manager."
  }

  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if s.Sid == "EcrPullOwnRepository"]) == ["arn:aws:ecr:af-south-1:123456789012:repository/cd-svc-disputes"]
    error_message = "Image pull must be scoped to the service's own repository."
  }

  assert {
    condition     = aws_iam_role.execution.path == "/cd/" && aws_iam_role.execution.permissions_boundary == var.permissions_boundary_arn && aws_iam_role.task.permissions_boundary == var.permissions_boundary_arn
    error_message = "Roles use path /cd/ and the workload permissions boundary."
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.task[0].policy).Statement == [{ Sid = "SendNotifications", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = ["arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications"] }]
    error_message = "The task role policy is exactly the caller statements, without null Condition keys."
  }
}

run "migrate_family_with_db" {
  command = plan

  assert {
    condition     = length(aws_ecs_task_definition.migrate) == 1 && aws_ecs_task_definition.migrate[0].family == "cd-disputes-migrate"
    error_message = "DB services get a cd-<svc>-migrate family."
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.migrate[0].container_definitions)[0].command == ["migrate"] &&
      jsondecode(aws_ecs_task_definition.migrate[0].container_definitions)[0].image == var.image_uri &&
      jsondecode(aws_ecs_task_definition.migrate[0].container_definitions)[0].readonlyRootFilesystem == true &&
      jsondecode(aws_ecs_task_definition.migrate[0].container_definitions)[0].user == "1000:1000" &&
      one(aws_ecs_task_definition.migrate[0].runtime_platform).cpu_architecture == "ARM64"
    )
    error_message = "migrate runs the same image with command migrate, hardened like the service."
  }

  assert {
    condition = jsondecode(aws_ecs_task_definition.migrate[0].container_definitions)[0].secrets == [{
      name      = "MIGRATOR_DATABASE_URL"
      valueFrom = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_migrator-MnOpQr:url::"
    }]
    error_message = "migrate gets only MIGRATOR_DATABASE_URL from the migrator secret key url."
  }

  assert {
    condition     = !contains([for s in jsondecode(aws_ecs_task_definition.service.container_definitions)[0].secrets : s.name], "MIGRATOR_DATABASE_URL")
    error_message = "The serving container must not receive the migrator URL."
  }
}

run "web_without_db_or_service_port" {
  command = apply

  variables {
    service_name           = "web"
    image_uri              = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-web:initial"
    service_connect_server = false
    health_check_path      = "/healthz"
    migrate                = null
    secrets                = {}
    task_role_statements   = []
    target_groups = {
      "8080" = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-web-8080/abc", container_port = 8080 }
    }
    environment = {
      OIDC_ISSUER          = "https://cognito-idp.af-south-1.amazonaws.com/af-south-1_example"
      OIDC_CLIENT_ID       = "spa-client"
      OIDC_REDIRECT_URI    = "https://d111111abcdef8.cloudfront.net/callback"
      OIDC_LOGOUT_URL      = "https://cd-example.auth.af-south-1.amazoncognito.com/logout"
      OIDC_POST_LOGOUT_URI = "https://d111111abcdef8.cloudfront.net/"
      OIDC_TOKEN_ORIGIN    = "https://cd-example.auth.af-south-1.amazoncognito.com"
      UPLOAD_ORIGIN        = "https://cd-dev-quarantine-123456789012.s3.af-south-1.amazonaws.com"
    }
  }

  assert {
    condition     = length(aws_ecs_task_definition.migrate) == 0 && output.migrate_task_definition_family == null
    error_message = "No migrate family without a database."
  }

  assert {
    condition     = length(aws_ecs_service.this.service_connect_configuration) == 0
    error_message = "web has no Service Connect."
  }

  assert {
    condition     = [for p in jsondecode(aws_ecs_task_definition.service.container_definitions)[0].portMappings : p.containerPort] == [8080]
    error_message = "web exposes 8080 only."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service.container_definitions)[0].user == "101:101" && jsondecode(aws_ecs_task_definition.service.container_definitions)[0].readonlyRootFilesystem == true
    error_message = "web runs as nginx-unprivileged uid 101 on a read-only root."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.service.container_definitions)[0].healthCheck.command[5] == "http://127.0.0.1:8080/healthz"
    error_message = "web health check must hit /healthz."
  }

  assert {
    condition     = length(aws_iam_role_policy.task) == 0 && !contains([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Sid], "ReadOwnSecrets")
    error_message = "web has no task policy and no secret access."
  }
}

run "lb_8081_only_when_requested" {
  command = plan

  variables {
    service_name = "transactions"
    image_uri    = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-svc-transactions:initial"
    environment  = {}
    target_groups = {
      "8080" = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-transactions-8080/abc", container_port = 8080 }
    }
  }

  assert {
    condition     = [for lb in aws_ecs_service.this.load_balancer : lb.container_port] == [8080]
    error_message = "Without a \"8081\" entry only the 8080 attachment exists."
  }
}

run "lb_8081_attached_for_disputes" {
  command = plan

  assert {
    condition     = toset([for lb in aws_ecs_service.this.load_balancer : lb.container_port]) == toset([8080, 8081])
    error_message = "disputes attaches both 8080 and 8081 target groups (ADR-059)."
  }
}

run "lb_8081_rejected_for_transactions" {
  command = plan

  variables {
    service_name = "transactions"
    image_uri    = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-svc-transactions:initial"
    environment  = {}
  }

  expect_failures = [var.target_groups]
}

run "autoscaling_when_enabled" {
  command = plan

  variables {
    enable_autoscaling = true
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].min_capacity == 1 && aws_appautoscaling_target.this[0].max_capacity == 2 && aws_appautoscaling_target.this[0].resource_id == "service/cd/cd-disputes"
    error_message = "Autoscaling target is 1-2 tasks on service/cd/cd-disputes."
  }

  assert {
    condition = (
      one(aws_appautoscaling_policy.cpu[0].target_tracking_scaling_policy_configuration).target_value == 60 &&
      one(one(aws_appautoscaling_policy.cpu[0].target_tracking_scaling_policy_configuration).predefined_metric_specification).predefined_metric_type == "ECSServiceAverageCPUUtilization"
    )
    error_message = "Scale on average CPU at 60%."
  }
}

run "cloud_map_fallback_keeps_names_apart" {
  command = plan

  variables {
    register_cloud_map_service = true
  }

  assert {
    condition     = aws_service_discovery_service.fallback[0].name == "disputes" && one(one(aws_ecs_service.this.service_connect_configuration).service).discovery_name == "disputes-sc"
    error_message = "DNS service is disputes.cd.internal; the Service Connect discovery name moves aside."
  }

  assert {
    condition     = one(one(one(aws_ecs_service.this.service_connect_configuration).service).client_alias).dns_name == "disputes"
    error_message = "Peers still call http://disputes:8081."
  }
}

run "ready_is_not_a_container_health_check" {
  command = plan

  variables {
    health_check_path = "/ready"
  }

  expect_failures = [var.health_check_path]
}

run "mixed_condition_statements" {
  command = apply

  variables {
    task_role_statements = [
      {
        Sid      = "SendNotifications"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = ["arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications"]
      },
      {
        Sid       = "EncryptNotifications"
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey"]
        Resource  = ["arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"]
        Condition = { StringEquals = { "kms:ViaService" = ["sqs.af-south-1.amazonaws.com"] } }
      },
      {
        Sid       = "PutQuarantine"
        Effect    = "Allow"
        Action    = ["s3:PutObject"]
        Resource  = ["arn:aws:s3:::cd-dev-quarantine-123456789012/*"]
        Condition = { ArnLike = { "aws:SourceArn" = ["arn:aws:ecs:af-south-1:123456789012:task/cd/*", "arn:aws:ecs:af-south-1:123456789012:service/cd/*"] } }
      },
    ]
  }

  assert {
    condition = jsondecode(aws_iam_role_policy.task[0].policy).Statement == [
      { Sid = "SendNotifications", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = ["arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications"] },
      {
        Sid       = "EncryptNotifications", Effect = "Allow", Action = ["kms:GenerateDataKey"]
        Resource  = ["arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"]
        Condition = { StringEquals = { "kms:ViaService" = ["sqs.af-south-1.amazonaws.com"] } }
      },
      {
        Sid       = "PutQuarantine", Effect = "Allow", Action = ["s3:PutObject"], Resource = ["arn:aws:s3:::cd-dev-quarantine-123456789012/*"]
        Condition = { ArnLike = { "aws:SourceArn" = ["arn:aws:ecs:af-south-1:123456789012:task/cd/*", "arn:aws:ecs:af-south-1:123456789012:service/cd/*"] } }
      },
    ]
    error_message = "A list mixing no Condition, StringEquals and ArnLike renders as given; no null Condition key."
  }
}
