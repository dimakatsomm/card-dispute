data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  tool_keys = ["db-bootstrap", "dev-seed", "net-probe"]

  # The dev-tools image runs as USER node (1000), like the backend images.
  container_user = "1000:1000"

  image_parts        = regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com/([^:@]+)", var.image_uri)
  ecr_repository_arn = "arn:${local.partition}:ecr:${local.image_parts[1]}:${local.image_parts[0]}:repository/${local.image_parts[2]}"

  secret_arn_base       = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:"
  seed_user_secrets_arn = "${local.secret_arn_base}${var.seed_user_secret_name_prefix}*"
  # Secrets Manager appends "-" and six random characters to every secret ARN.
  probe_user_secret_arn = "${local.secret_arn_base}${var.seed_user_secret_name_prefix}${var.probe_seed_username}-??????"
  secretsmanager_via    = "secretsmanager.${local.region}.amazonaws.com"

  migrator_schemas = ["auth", "users", "transactions", "disputes"]

  bootstrap_secrets = merge(
    {
      DB_ADMIN_USER     = { secret_arn = var.aurora.master_secret_arn, json_key = "username" }
      DB_ADMIN_PASSWORD = { secret_arn = var.aurora.master_secret_arn, json_key = "password" }
    },
    { for role, arn in var.aurora.role_secret_arns : "DB_PASSWORD_${upper(role)}" => { secret_arn = arn, json_key = "password" } },
  )

  seed_secrets = {
    for schema in local.migrator_schemas : "MIGRATOR_DATABASE_URL_${upper(schema)}" => {
      secret_arn = var.aurora.role_secret_arns["${schema}_migrator"]
      json_key   = "url"
    }
  }

  tools = {
    db-bootstrap = {
      command = ["bootstrap"]
      # No DB_ADMIN_SSL: the bootstrap then appends sslmode=verify-full.
      environment = {
        LOG_LEVEL     = "info"
        DB_ADMIN_HOST = var.aurora.endpoint
        DB_ADMIN_PORT = tostring(var.aurora.port)
        DB_ADMIN_NAME = var.aurora.database_name
      }
      secrets = local.bootstrap_secrets
    }
    dev-seed = {
      command = ["seed"]
      environment = {
        LOG_LEVEL                   = "info"
        SEED_TARGET                 = "aws"
        AWS_REGION                  = local.region
        COGNITO_USER_POOL_ID        = var.cognito_user_pool_id
        SEED_USER_SECRET_PREFIX     = var.seed_user_secret_name_prefix
        SEED_USER_SECRET_KMS_KEY_ID = var.data_kms_key_arn
        DB_HOST                     = var.aurora.endpoint
        DB_PORT                     = tostring(var.aurora.port)
        DB_NAME                     = var.aurora.database_name
      }
      secrets = local.seed_secrets
    }
    net-probe = {
      command = ["probe"]
      environment = merge(
        {
          LOG_LEVEL            = "info"
          AWS_REGION           = local.region
          COGNITO_USER_POOL_ID = var.cognito_user_pool_id
          PROBE_USER_SECRET_ID = "${var.seed_user_secret_name_prefix}${var.probe_seed_username}"
        },
        var.probe_environment,
      )
      secrets = var.probe_secrets
    }
  }

  task_statements = {
    dev-seed = [
      {
        Sid      = "SeedCognitoUsersInPool"
        Effect   = "Allow"
        Action   = ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminGetUser", "cognito-idp:AdminDisableUser", "cognito-idp:AdminUpdateUserAttributes"]
        Resource = [var.cognito_user_pool_arn]
      },
      {
        Sid       = "CreateSeedUserSecretsWithDataKey"
        Effect    = "Allow"
        Action    = ["secretsmanager:CreateSecret"]
        Resource  = [local.seed_user_secrets_arn] # Partial wildcard: dev-seed creates these secrets at run time.
        Condition = { StringEquals = { "secretsmanager:KmsKeyId" = var.data_kms_key_arn } }
      },
      {
        Sid      = "MaintainSeedUserSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource = [local.seed_user_secrets_arn] # Partial wildcard: dev-seed creates these secrets at run time.
      },
      {
        Sid      = "SeedUserSecretsDataKey"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = [var.data_kms_key_arn]
        Condition = {
          StringEquals = { "kms:ViaService" = local.secretsmanager_via }
          StringLike   = { "kms:EncryptionContext:SecretARN" = local.seed_user_secrets_arn }
        }
      },
    ]
    net-probe = [
      {
        Sid      = "UserTokenViaE2eClient"
        Effect   = "Allow"
        Action   = ["cognito-idp:AdminInitiateAuth"]
        Resource = [var.cognito_user_pool_arn]
      },
      {
        Sid      = "ReadProbeUserPassword"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [local.probe_user_secret_arn]
      },
      {
        Sid      = "DecryptProbeUserPassword"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.data_kms_key_arn]
        Condition = {
          StringEquals = { "kms:ViaService" = local.secretsmanager_via }
          StringLike   = { "kms:EncryptionContext:SecretARN" = local.probe_user_secret_arn }
        }
      },
    ]
  }

  value_from = {
    for key, tool in local.tools :
    key => { for name, s in tool.secrets : name => s.json_key == null ? s.secret_arn : "${s.secret_arn}:${s.json_key}::" }
  }

  containers = {
    for key, tool in local.tools : key => {
      name                   = key
      image                  = var.image_uri
      essential              = true
      command                = tool.command
      user                   = local.container_user
      privileged             = false
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      linuxParameters        = { capabilities = { drop = ["ALL"] }, initProcessEnabled = true }
      environment            = [for k in sort(keys(tool.environment)) : { name = k, value = tool.environment[k] }]
      secrets                = [for k in sort(keys(tool.secrets)) : { name = k, valueFrom = local.value_from[key][k] }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this[key].name
          awslogs-region        = local.region
          awslogs-stream-prefix = key
        }
      }
    }
  }

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

  execution_statements = {
    for key, tool in local.tools : key => concat(
      [
        {
          Sid      = "EcrAuthToken"
          Effect   = "Allow"
          Action   = ["ecr:GetAuthorizationToken"]
          Resource = ["*"] # ecr:GetAuthorizationToken has no resource-level permission.
        },
        {
          Sid      = "EcrPullDevTools"
          Effect   = "Allow"
          Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
          Resource = [local.ecr_repository_arn]
        },
        {
          Sid      = "WriteOwnLogGroup"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = ["${aws_cloudwatch_log_group.this[key].arn}:log-stream:*"]
        },
      ],
      [for s in [
        {
          Sid      = "ReadReferencedSecrets"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = sort(distinct([for ref in values(tool.secrets) : ref.secret_arn]))
        },
        {
          Sid       = "DecryptSecretsWithDataKey"
          Effect    = "Allow"
          Action    = ["kms:Decrypt"]
          Resource  = [var.data_kms_key_arn]
          Condition = { StringEquals = { "kms:ViaService" = local.secretsmanager_via } }
        },
      ] : s if length(tool.secrets) > 0],
    )
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(local.tool_keys)
  name              = "/${var.name_prefix}/dev/tools/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
  tags              = { component = "dev-tools" }
}

resource "aws_iam_role" "execution" {
  for_each             = toset(local.tool_keys)
  name                 = "${var.name_prefix}-${each.key}-exec"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.ecs_tasks_trust
  tags                 = { component = "dev-tools" }
}

resource "aws_iam_role_policy" "execution" {
  for_each = toset(local.tool_keys)
  name     = "${var.name_prefix}-${each.key}-exec"
  role     = aws_iam_role.execution[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = local.execution_statements[each.key] })
}

# db-bootstrap calls no AWS API, so it gets no task role.
resource "aws_iam_role" "task" {
  for_each             = toset(keys(local.task_statements))
  name                 = "${var.name_prefix}-${each.key}-task"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.ecs_tasks_trust
  tags                 = { component = "dev-tools" }
}

resource "aws_iam_role_policy" "task" {
  for_each = toset(keys(local.task_statements))
  name     = "${var.name_prefix}-${each.key}-task"
  role     = aws_iam_role.task[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = local.task_statements[each.key] })
}

resource "aws_ecs_task_definition" "this" {
  for_each                 = toset(local.tool_keys)
  family                   = "${var.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = contains(keys(local.task_statements), each.key) ? aws_iam_role.task[each.key].arn : null
  container_definitions    = jsonencode([local.containers[each.key]])
  # The dev-tools pipeline registers SHA revisions outside Terraform; keep older ones runnable.
  skip_destroy = true

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "tmp"
  }

  tags = { component = "dev-tools" }
}
