data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name           = "${var.name_prefix}-${var.service_name}"
  container_name = var.service_name
  log_group_name = "/${var.name_prefix}/dev/ecs/${var.service_name}"
  region         = data.aws_region.current.region
  account_id     = data.aws_caller_identity.current.account_id
  partition      = data.aws_partition.current.partition

  public_port      = 8080
  service_port     = 8081
  has_service_port = var.service_name != "web"
  is_web           = var.service_name == "web"

  # Image USER: node (1000) in the backend images, nginx-unprivileged 101 in web.
  container_user = local.is_web ? "101:101" : "1000:1000"

  # A Cloud Map service name is unique per namespace, so the fallback DNS service takes <svc> and Service Connect moves aside.
  discovery_name = var.register_cloud_map_service ? "${var.service_name}-sc" : var.service_name

  peer_url = { for s in ["auth", "users", "transactions", "disputes"] : s => "http://${s}:${local.service_port}" }

  default_environment = {
    auth = {
      PUBLIC_PORT  = tostring(local.public_port)
      SERVICE_PORT = tostring(local.service_port)
      LOG_LEVEL    = "info"
      DB_POOL_MAX  = "5"
    }
    users = {
      PUBLIC_PORT  = tostring(local.public_port)
      SERVICE_PORT = tostring(local.service_port)
      LOG_LEVEL    = "info"
      DB_POOL_MAX  = "5"
      AUTH_URL     = local.peer_url.auth
    }
    transactions = {
      PUBLIC_PORT          = tostring(local.public_port)
      SERVICE_PORT         = tostring(local.service_port)
      LOG_LEVEL            = "info"
      DB_POOL_MAX          = "5"
      AUTH_URL             = local.peer_url.auth
      USERS_SERVICE_URL    = local.peer_url.users
      DISPUTES_SERVICE_URL = local.peer_url.disputes
    }
    disputes = {
      PUBLIC_PORT              = tostring(local.public_port)
      SERVICE_PORT             = tostring(local.service_port)
      LOG_LEVEL                = "info"
      DB_POOL_MAX              = "5"
      AUTH_URL                 = local.peer_url.auth
      USERS_SERVICE_URL        = local.peer_url.users
      TRANSACTIONS_SERVICE_URL = local.peer_url.transactions
      AWS_REGION               = local.region
    }
    web = {
      API_BASE = "/api"
    }
  }

  environment = merge(local.default_environment[var.service_name], var.environment)

  migrate_enabled     = var.migrate != null
  migrate_environment = local.migrate_enabled ? merge({ LOG_LEVEL = "info" }, var.migrate.environment) : {}
  migrate_secrets     = local.migrate_enabled ? var.migrate.secrets : {}

  secret_arns     = distinct(concat([for s in values(var.secrets) : s.secret_arn], [for s in values(local.migrate_secrets) : s.secret_arn]))
  has_secret_refs = length(var.secrets) + length(local.migrate_secrets) > 0

  image_parts        = regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com/([^:@]+)", var.image_uri)
  ecr_repository_arn = "arn:${local.partition}:ecr:${local.image_parts[1]}:${local.image_parts[0]}:repository/${local.image_parts[2]}"

  port_mappings = concat(
    [{ name = "public", containerPort = local.public_port, protocol = "tcp", appProtocol = "http" }],
    local.has_service_port ? [{ name = "service", containerPort = local.service_port, protocol = "tcp", appProtocol = "http" }] : [],
  )

  container_base = {
    name                   = local.container_name
    image                  = var.image_uri
    essential              = true
    user                   = local.container_user
    privileged             = false
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    linuxParameters        = { capabilities = { drop = ["ALL"] }, initProcessEnabled = true }
  }

  log_options = {
    awslogs-group   = aws_cloudwatch_log_group.this.name
    awslogs-region  = local.region
    mode            = "non-blocking"
    max-buffer-size = "4m"
  }

  service_container = merge(local.container_base, {
    portMappings = local.port_mappings
    environment  = [for k in sort(keys(local.environment)) : { name = k, value = local.environment[k] }]
    secrets      = [for k in sort(keys(var.secrets)) : { name = k, valueFrom = local.value_from.service[k] }]
    healthCheck = {
      command     = ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:${local.public_port}${var.health_check_path}"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-stream-prefix = "service" }) }
  })

  value_from = {
    for scope, refs in { service = var.secrets, migrate = local.migrate_secrets } :
    scope => { for k, s in refs : k => s.json_key == null ? s.secret_arn : "${s.secret_arn}:${s.json_key}::" }
  }

  migrate_container = local.migrate_enabled ? merge(local.container_base, {
    command          = var.migrate.command
    environment      = [for k in sort(keys(local.migrate_environment)) : { name = k, value = local.migrate_environment[k] }]
    secrets          = [for k in sort(keys(local.migrate_secrets)) : { name = k, valueFrom = local.value_from.migrate[k] }]
    logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-stream-prefix = "migrate" }) }
  }) : null

  ecs_tasks_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EcsTasksAssume"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = ["sts:AssumeRole"]
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:ecs:${local.region}:${local.account_id}:*" }
      }
    }]
  })

  execution_statements = concat(
    [
      {
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = ["*"] # ecr:GetAuthorizationToken has no resource-level permission.
      },
      {
        Sid      = "EcrPullOwnRepository"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = [local.ecr_repository_arn]
      },
      {
        Sid      = "WriteOwnLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.this.arn}:log-stream:*"]
      },
    ],
    [for s in [
      {
        Sid      = "ReadOwnSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.secret_arns
      },
      {
        Sid       = "DecryptSecretsWithDataKey"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = [var.data_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" } }
      },
    ] : s if local.has_secret_refs],
  )

  task_statements = [for s in var.task_role_statements : { for k, v in s : k => v if v != null }]
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
  tags              = { component = "ecs-service" }
}

resource "aws_iam_role" "execution" {
  name                 = "${local.name}-exec"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.ecs_tasks_trust
  tags                 = { component = "ecs-service" }
}

resource "aws_iam_role_policy" "execution" {
  name   = "${local.name}-exec"
  role   = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.execution_statements })
}

resource "aws_iam_role" "task" {
  name                 = "${local.name}-task"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.ecs_tasks_trust
  tags                 = { component = "ecs-service" }
}

resource "aws_iam_role_policy" "task" {
  count  = length(var.task_role_statements) > 0 ? 1 : 0
  name   = "${local.name}-task"
  role   = aws_iam_role.task.id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.task_statements })
}

resource "aws_ecs_task_definition" "service" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.service_container])
  # Keeps the revision a rolled-back or ignore_changes-pinned service may still run.
  skip_destroy = true

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  tags = { component = "ecs-service" }
}

resource "aws_ecs_task_definition" "migrate" {
  count                    = local.migrate_enabled ? 1 : 0
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions    = jsonencode([local.migrate_container])
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  tags = { component = "ecs-service" }
}

resource "aws_service_discovery_service" "fallback" {
  count = var.register_cloud_map_service ? 1 : 0
  name  = var.service_name

  dns_config {
    namespace_id   = var.namespace_id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  tags = { component = "ecs-service" }
}

resource "aws_ecs_service" "this" {
  name                               = local.name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.service.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = length(var.target_groups) > 0 ? 60 : null
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  wait_for_steady_state              = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_groups
    content {
      target_group_arn = load_balancer.value.arn
      container_name   = local.container_name
      container_port   = load_balancer.value.container_port
    }
  }

  dynamic "service_connect_configuration" {
    for_each = var.service_connect_server ? [1] : []
    content {
      enabled   = true
      namespace = var.namespace_arn

      service {
        port_name      = "service"
        discovery_name = local.discovery_name

        client_alias {
          port     = local.service_port
          dns_name = var.service_name
        }
      }

      log_configuration {
        log_driver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = local.region
          awslogs-stream-prefix = "service-connect"
        }
      }
    }
  }

  dynamic "service_registries" {
    for_each = var.register_cloud_map_service ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.fallback[0].arn
    }
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = { component = "ecs-service" }
}

resource "aws_appautoscaling_target" "this" {
  count              = var.enable_autoscaling ? 1 : 0
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${element(split("/", var.cluster_arn), 1)}/${aws_ecs_service.this.name}"
  min_capacity       = var.autoscaling_min_capacity
  max_capacity       = var.autoscaling_max_capacity
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.enable_autoscaling ? 1 : 0
  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
