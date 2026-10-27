data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name           = "${var.name_prefix}-${var.function_key}"
  alias_name     = "live"
  log_group_name = "/aws/lambda/${local.name}"
  region         = data.aws_region.current.region
  account_id     = data.aws_caller_identity.current.account_id
  partition      = data.aws_partition.current.partition

  create_function = var.image_uri != null
  has_schedule    = var.schedule != null

  # Built from names so role policies exist before (or without) the function.
  alias_arn_by_name = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.name}:${local.alias_name}"
  # Scheduler presents the schedule group ARN as aws:SourceArn, not the schedule ARN.
  schedule_group_arn = "arn:${local.partition}:scheduler:${local.region}:${local.account_id}:schedule-group/default"

  default_environment = {
    evidence-intake   = { LOG_LEVEL = "info", EVIDENCE_REQUIRE_SCAN = "true" }
    dispute-notifier  = { LOG_LEVEL = "info" }
    retention-sweeper = { LOG_LEVEL = "info", DB_SSL = "true", METRICS_NAMESPACE = "cd/retention-sweeper" }
  }

  environment = merge(local.default_environment[var.function_key], var.environment)

  lambda_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LambdaAssume"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["sts:AssumeRole"]
    }]
  })

  module_statements = concat(
    [
      {
        Sid      = "WriteOwnLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.this.arn}:log-stream:*"]
      },
      {
        Sid    = "VpcEniManagement"
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ]
        Resource = ["*"] # Lambda creates VPC ENIs with unknown ids; AWS documents these on * (AWSLambdaVPCAccessExecutionRole).
      },
      {
        Sid      = "VpcEniDescribe"
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = ["*"] # Describe actions have no resource-level permission.
      },
    ],
    [for s in [
      {
        Sid      = "SendAsyncFailures"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [var.async_on_failure_arn]
      },
      {
        Sid       = "EncryptAsyncFailures"
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource  = [var.data_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = "sqs.${local.region}.amazonaws.com" } }
      },
    ] : s if var.async_on_failure_arn != null],
  )

  caller_statements = [for s in var.policy_statements : { for k, v in s : k => v if v != null }]

  scheduler_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SchedulerAssume"
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = ["sts:AssumeRole"]
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = local.schedule_group_arn }
      }
    }]
  })

  scheduler_statements = [for s in [
    {
      Sid      = "InvokeLiveAlias"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [local.alias_arn_by_name]
    },
    {
      Sid      = "SendScheduleFailures"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = [try(var.schedule.dlq_arn, null)]
    },
    {
      Sid       = "EncryptScheduleFailures"
      Effect    = "Allow"
      Action    = ["kms:GenerateDataKey", "kms:Decrypt"]
      Resource  = [var.data_kms_key_arn]
      Condition = { StringEquals = { "kms:ViaService" = "sqs.${local.region}.amazonaws.com" } }
    },
  ] : s if local.has_schedule]
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
  tags              = { component = "lambda-fn" }
}

resource "aws_iam_role" "function" {
  name                 = "${local.name}-role"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.lambda_trust
  tags                 = { component = "lambda-fn" }
}

resource "aws_iam_role_policy" "function" {
  name   = "${local.name}-role"
  role   = aws_iam_role.function.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat(local.module_statements, local.caller_statements) })
}

resource "aws_lambda_function" "this" {
  #checkov:skip=CKV_AWS_50:X-Ray dropped (ADR-063); tracing is PassThrough.
  #checkov:skip=CKV_AWS_115:No reserved concurrency: new-account concurrency quota (OWN-1).
  #checkov:skip=CKV_AWS_116:Failures go to on-failure destinations, ESM redrive or the scheduler DLQ, not a function DLQ.
  #checkov:skip=CKV_AWS_272:Code signing does not apply to container images.
  #checkov:skip=CKV_AWS_173:Environment holds only ids and secret references; cd-data admits no Lambda ViaService, so the AWS-managed key is used.
  count         = local.create_function ? 1 : 0
  function_name = local.name
  role          = aws_iam_role.function.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  architectures = ["arm64"]
  memory_size   = var.memory_mb
  timeout       = var.timeout_seconds
  publish       = true

  environment {
    variables = local.environment
  }

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [var.security_group_id]
  }

  tracing_config {
    mode = "PassThrough"
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  # The policy must exist before Lambda validates ENI permissions at create time.
  depends_on = [aws_iam_role_policy.function]

  tags = { component = "lambda-fn" }
}

resource "aws_lambda_alias" "live" {
  count            = local.create_function ? 1 : 0
  name             = local.alias_name
  function_name    = aws_lambda_function.this[0].function_name
  function_version = aws_lambda_function.this[0].version

  lifecycle {
    ignore_changes = [function_version]
  }
}

resource "aws_lambda_function_event_invoke_config" "live" {
  count                  = local.create_function ? 1 : 0
  function_name          = aws_lambda_function.this[0].function_name
  qualifier              = aws_lambda_alias.live[0].name
  maximum_retry_attempts = var.async_max_retries

  dynamic "destination_config" {
    for_each = var.async_on_failure_arn != null ? [var.async_on_failure_arn] : []
    content {
      on_failure {
        destination = destination_config.value
      }
    }
  }

  depends_on = [aws_iam_role_policy.function]
}

resource "aws_lambda_event_source_mapping" "sqs" {
  count                   = local.create_function && var.sqs_event_source != null ? 1 : 0
  event_source_arn        = var.sqs_event_source.queue_arn
  function_name           = aws_lambda_alias.live[0].arn
  batch_size              = var.sqs_event_source.batch_size
  function_response_types = ["ReportBatchItemFailures"]
  enabled                 = true

  depends_on = [aws_iam_role_policy.function]
}

resource "aws_iam_role" "scheduler" {
  count                = local.has_schedule ? 1 : 0
  name                 = "${local.name}-scheduler"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.scheduler_trust
  tags                 = { component = "lambda-fn" }
}

resource "aws_iam_role_policy" "scheduler" {
  count  = local.has_schedule ? 1 : 0
  name   = "${local.name}-scheduler"
  role   = aws_iam_role.scheduler[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.scheduler_statements })
}

resource "aws_scheduler_schedule" "this" {
  #checkov:skip=CKV_AWS_297:The schedule carries no target input (the sweeper ignores event content), so there is nothing to encrypt.
  count                        = local.create_function && local.has_schedule ? 1 : 0
  name                         = local.name
  group_name                   = "default"
  schedule_expression          = var.schedule.expression
  schedule_expression_timezone = var.schedule.timezone
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_alias.live[0].arn
    role_arn = aws_iam_role.scheduler[0].arn

    retry_policy {
      maximum_retry_attempts       = var.schedule_max_retries
      maximum_event_age_in_seconds = 3600
    }

    dead_letter_config {
      arn = var.schedule.dlq_arn
    }
  }

  depends_on = [aws_iam_role_policy.scheduler]
}
