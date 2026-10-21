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
    defaults = { arn = "arn:aws:logs:af-south-1:123456789012:log-group:/aws/lambda/cd-fn" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/cd/cd-fn-role" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:af-south-1:123456789012:function:cd-fn", version = "1" }
  }
  mock_resource "aws_lambda_alias" {
    defaults = { arn = "arn:aws:lambda:af-south-1:123456789012:function:cd-fn:live" }
  }
  mock_resource "aws_scheduler_schedule" {
    defaults = { arn = "arn:aws:scheduler:af-south-1:123456789012:schedule/default/cd-fn" }
  }
}

variables {
  name_prefix              = "cd"
  function_key             = "evidence-intake"
  permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cd-workload-boundary"
  iam_path                 = "/cd/"
  log_retention_days       = 7
  logs_kms_key_arn         = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  data_kms_key_arn         = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  image_uri                = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-lambda-evidence-intake:initial"
  timeout_seconds          = 60
  subnet_ids               = ["subnet-private-a", "subnet-private-b"]
  security_group_id        = "sg-evidence-intake"
  environment = {
    QUARANTINE_BUCKET        = "cd-dev-quarantine-123456789012"
    SERVICE_CLIENT_SECRET_ID = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-evidence-intake-AbCdEf"
  }
  policy_statements = [{
    Sid      = "ReadDeleteQuarantine"
    Effect   = "Allow"
    Action   = ["s3:GetObject", "s3:DeleteObject"]
    Resource = ["arn:aws:s3:::cd-dev-quarantine-123456789012/intake/*"]
  }]
  async_on_failure_arn = "arn:aws:sqs:af-south-1:123456789012:cd-evidence-intake-dlq"
}

run "no_function_without_image" {
  command = apply

  variables {
    image_uri = null
  }

  assert {
    condition     = length(aws_lambda_function.this) == 0 && length(aws_lambda_alias.live) == 0 && length(aws_lambda_function_event_invoke_config.live) == 0
    error_message = "No function, alias or invoke config may exist while image_uri is null."
  }

  assert {
    condition     = output.function_name == null && output.function_arn == null && output.alias_arn == null
    error_message = "Function outputs must be null when the function is not created."
  }

  assert {
    condition     = aws_iam_role.function.name == "cd-evidence-intake-role" && aws_cloudwatch_log_group.this.name == "/aws/lambda/cd-evidence-intake"
    error_message = "The role and log group exist regardless, so consumers can reference them."
  }

  assert {
    condition     = output.role_arn != null && output.role_name == "cd-evidence-intake-role" && output.log_group_name == "/aws/lambda/cd-evidence-intake"
    error_message = "Phase A: role outputs are non-null so queue policies can name the role."
  }
}

run "intake_function_shape" {
  command = apply

  assert {
    condition     = aws_lambda_function.this[0].package_type == "Image" && aws_lambda_function.this[0].architectures == tolist(["arm64"])
    error_message = "The function must be an arm64 container image."
  }

  assert {
    condition     = aws_lambda_function.this[0].memory_size == 256 && aws_lambda_function.this[0].timeout == 60 && aws_lambda_function.this[0].publish
    error_message = "256 MB, the given timeout and publish = true."
  }

  assert {
    condition     = aws_lambda_function.this[0].tracing_config[0].mode == "PassThrough"
    error_message = "X-Ray is dropped: tracing must be PassThrough."
  }

  assert {
    condition     = aws_lambda_function.this[0].vpc_config[0].security_group_ids == toset(["sg-evidence-intake"]) && length(aws_lambda_function.this[0].vpc_config[0].subnet_ids) == 2
    error_message = "The function runs in the private subnets with its own security group."
  }

  assert {
    condition     = aws_lambda_alias.live[0].name == "live" && output.alias_arn == aws_lambda_alias.live[0].arn
    error_message = "Alias live must exist and be output."
  }

  assert {
    condition     = aws_lambda_function.this[0].environment[0].variables["EVIDENCE_REQUIRE_SCAN"] == "true" && aws_lambda_function.this[0].environment[0].variables["SERVICE_CLIENT_SECRET_ID"] != ""
    error_message = "Intake defaults EVIDENCE_REQUIRE_SCAN=true and receives the secret as an id."
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.retention_in_days == 7 && aws_cloudwatch_log_group.this.kms_key_id == var.logs_kms_key_arn
    error_message = "Log group must have retention and KMS."
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.live[0].maximum_retry_attempts == 2 && aws_lambda_function_event_invoke_config.live[0].qualifier == "live"
    error_message = "Async invokes of the alias retry twice."
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.live[0].destination_config[0].on_failure[0].destination == var.async_on_failure_arn
    error_message = "Failed async invokes go to the evidence-intake DLQ."
  }

  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.function.policy).Statement :
    s.Action == ["sqs:SendMessage"] && s.Resource == [var.async_on_failure_arn]])
    error_message = "The role must be able to send to the on-failure DLQ."
  }

  assert {
    condition     = length(aws_lambda_event_source_mapping.sqs) == 0 && length(aws_scheduler_schedule.this) == 0 && output.scheduler_role_arn == null
    error_message = "Intake has no ESM and no schedule."
  }
}

run "environment_not_on_cd_data" {
  command = apply

  assert {
    condition     = aws_lambda_function.this[0].kms_key_arn == null
    error_message = "No kms_key_arn on the function: the cd-data key policy admits no Lambda ViaService."
  }

  assert {
    condition = !anytrue([for s in jsondecode(aws_iam_role_policy.function.policy).Statement :
    contains(s.Action, "kms:Decrypt") && !can(s.Condition.StringEquals["kms:ViaService"])])
    error_message = "The role decrypts cd-data only via SQS; no environment-decrypt statement."
  }
}

run "image_uri_is_ignored_after_create" {
  command = apply

  variables {
    image_uri = "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-lambda-evidence-intake:other"
  }

  assert {
    condition     = aws_lambda_function.this[0].image_uri == "123456789012.dkr.ecr.af-south-1.amazonaws.com/cd-lambda-evidence-intake:initial"
    error_message = "ignore_changes = [image_uri]: the pipeline owns the image after create."
  }
}

run "role_policies_have_no_wildcards_but_eni" {
  command = apply

  variables {
    function_key         = "retention-sweeper"
    timeout_seconds      = 300
    async_on_failure_arn = null
    environment = {
      DATABASE_SECRET_ID = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_retention-AbCdEf"
    }
    schedule = {
      expression = "cron(0 2 * * ? *)"
      timezone   = "Africa/Johannesburg"
      dlq_arn    = "arn:aws:sqs:af-south-1:123456789012:cd-retention-scheduler-dlq"
    }
  }

  assert {
    condition = alltrue(flatten([for p in [aws_iam_role_policy.function.policy, aws_iam_role_policy.scheduler[0].policy] : [
      for s in jsondecode(p).Statement : [for a in s.Action : a != "*" && !endswith(a, ":*")]
    ]]))
    error_message = "No * or service:* actions."
  }

  assert {
    condition = alltrue(flatten([for p in [aws_iam_role_policy.function.policy, aws_iam_role_policy.scheduler[0].policy] : [
      for s in jsondecode(p).Statement : contains(s.Resource, "*") ? contains(["VpcEniManagement", "VpcEniDescribe"], s.Sid) : true
    ]]))
    error_message = "Resource * only on the documented VPC ENI statements."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.function.policy).Statement : s.Action if contains(s.Resource, "*")])) == toset([
      "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses", "ec2:DescribeNetworkInterfaces",
    ])
    error_message = "The * exception covers exactly the five ENI actions."
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.function.policy).Statement : s.Resource if s.Sid == "WriteOwnLogGroup"]) == [
      "arn:aws:logs:af-south-1:123456789012:log-group:/aws/lambda/cd-fn:log-stream:*",
    ]
    error_message = "Logs are written only to the function's own log group."
  }

  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_role_policy.function.policy).Statement : s.Sid == "SendAsyncFailures"])
    error_message = "No DLQ send statement without async_on_failure_arn."
  }
}

run "sweeper_schedule" {
  command = apply

  variables {
    function_key         = "retention-sweeper"
    timeout_seconds      = 300
    async_on_failure_arn = null
    environment = {
      DATABASE_SECRET_ID = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/db/disputes_retention-AbCdEf"
    }
    schedule = {
      expression = "cron(0 2 * * ? *)"
      timezone   = "Africa/Johannesburg"
      dlq_arn    = "arn:aws:sqs:af-south-1:123456789012:cd-retention-scheduler-dlq"
    }
  }

  assert {
    condition     = aws_scheduler_schedule.this[0].schedule_expression == "cron(0 2 * * ? *)" && aws_scheduler_schedule.this[0].schedule_expression_timezone == "Africa/Johannesburg"
    error_message = "Daily 02:00 Africa/Johannesburg."
  }

  assert {
    condition     = aws_scheduler_schedule.this[0].target[0].arn == aws_lambda_alias.live[0].arn && aws_scheduler_schedule.this[0].target[0].role_arn == aws_iam_role.scheduler[0].arn
    error_message = "The schedule invokes the live alias as the scheduler role."
  }

  assert {
    condition     = aws_scheduler_schedule.this[0].target[0].dead_letter_config[0].arn == var.schedule.dlq_arn && aws_scheduler_schedule.this[0].target[0].retry_policy[0].maximum_retry_attempts == 2
    error_message = "Retry policy and the retention-scheduler DLQ."
  }

  assert {
    condition     = output.scheduler_role_arn == aws_iam_role.scheduler[0].arn
    error_message = "The scheduler role ARN is output for the messaging DLQ policy."
  }

  assert {
    condition = jsondecode(aws_iam_role.scheduler[0].assume_role_policy).Statement == [{
      Sid       = "SchedulerAssume"
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = ["sts:AssumeRole"]
      Condition = {
        StringEquals = { "aws:SourceAccount" = "123456789012" }
        ArnEquals    = { "aws:SourceArn" = "arn:aws:scheduler:af-south-1:123456789012:schedule/default/cd-retention-sweeper" }
      }
    }]
    error_message = "Only Scheduler, from this account and this schedule, may assume the role."
  }

  assert {
    condition = toset([for s in jsondecode(aws_iam_role_policy.scheduler[0].policy).Statement : jsonencode([s.Action, s.Resource]) if s.Sid != "EncryptScheduleFailures"]) == toset([
      jsonencode([["lambda:InvokeFunction"], ["arn:aws:lambda:af-south-1:123456789012:function:cd-retention-sweeper:live"]]),
      jsonencode([["sqs:SendMessage"], [var.schedule.dlq_arn]]),
    ])
    error_message = "The scheduler role may only invoke the alias and send to its DLQ."
  }

  assert {
    condition     = aws_lambda_function.this[0].environment[0].variables["DB_SSL"] == "true" && aws_lambda_function.this[0].timeout == 300
    error_message = "Sweeper defaults DB_SSL=true and uses its timeout."
  }
}

run "scheduler_role_exists_before_function" {
  command = apply

  variables {
    function_key         = "retention-sweeper"
    timeout_seconds      = 300
    image_uri            = null
    async_on_failure_arn = null
    schedule = {
      expression = "cron(0 2 * * ? *)"
      timezone   = "Africa/Johannesburg"
      dlq_arn    = "arn:aws:sqs:af-south-1:123456789012:cd-retention-scheduler-dlq"
    }
  }

  assert {
    condition     = length(aws_iam_role.scheduler) == 1 && length(aws_scheduler_schedule.this) == 0
    error_message = "The scheduler role is stable for messaging; the schedule waits for the function."
  }

  assert {
    condition     = output.scheduler_role_arn != null && output.role_arn != null && output.function_name == null
    error_message = "Phase A: the scheduler and function role ARNs are output before any image exists."
  }
}

run "notifier_event_source" {
  command = apply

  variables {
    function_key         = "dispute-notifier"
    timeout_seconds      = 30
    async_on_failure_arn = null
    environment = {
      SES_SENDER                = "noreply@example.com"
      SERVICE_CLIENT_SECRET_ARN = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-notifier-AbCdEf"
    }
    sqs_event_source = { queue_arn = "arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications" }
    policy_statements = [{
      Sid      = "ConsumeNotifications"
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      Resource = ["arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications"]
    }]
  }

  assert {
    condition     = aws_lambda_event_source_mapping.sqs[0].batch_size == 10 && aws_lambda_event_source_mapping.sqs[0].function_response_types == toset(["ReportBatchItemFailures"])
    error_message = "Notifier ESM: batch 10 with ReportBatchItemFailures."
  }

  assert {
    condition     = aws_lambda_event_source_mapping.sqs[0].function_name == aws_lambda_alias.live[0].arn
    error_message = "The ESM targets the live alias."
  }

  assert {
    condition     = coalesce(aws_lambda_function.this[0].reserved_concurrent_executions, -1) == -1
    error_message = "No reserved concurrency (account quota, OWN-1)."
  }
}

run "caller_condition_is_kept" {
  command = apply

  variables {
    function_key         = "dispute-notifier"
    timeout_seconds      = 30
    async_on_failure_arn = null
    environment          = { SES_SENDER = "noreply@example.com" }
    policy_statements = [{
      Sid       = "SendFromSender"
      Effect    = "Allow"
      Action    = ["ses:SendEmail"]
      Resource  = ["arn:aws:ses:af-south-1:123456789012:identity/noreply@example.com"]
      Condition = { StringEquals = { "ses:FromAddress" = ["noreply@example.com"] } }
    }]
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.function.policy).Statement : s.Condition if s.Sid == "SendFromSender"]) == {
      StringEquals = { "ses:FromAddress" = ["noreply@example.com"] }
    }
    error_message = "Caller statements keep their Condition."
  }

}

run "rejects_scan_disabled" {
  command = plan

  variables {
    environment = { EVIDENCE_REQUIRE_SCAN = "false" }
  }

  expect_failures = [var.environment]
}

run "rejects_raw_secret" {
  command = plan

  variables {
    environment = { SERVICE_CLIENT_SECRET = "s3cr3t" }
  }

  expect_failures = [var.environment]
}

run "rejects_reserved_lambda_variable" {
  command = plan

  variables {
    environment = { AWS_REGION = "af-south-1" }
  }

  expect_failures = [var.environment]
}

run "rejects_wildcard_statement" {
  command = plan

  variables {
    policy_statements = [{
      Sid      = "TooBroad"
      Effect   = "Allow"
      Action   = ["s3:*"]
      Resource = ["*"]
    }]
  }

  expect_failures = [var.policy_statements]
}

run "rejects_esm_without_consume_permissions" {
  command = plan

  variables {
    function_key      = "dispute-notifier"
    sqs_event_source  = { queue_arn = "arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications" }
    policy_statements = []
  }

  expect_failures = [var.policy_statements]
}

run "mixed_condition_statements" {
  command = apply

  variables {
    function_key         = "dispute-notifier"
    timeout_seconds      = 30
    async_on_failure_arn = null
    environment          = { SES_SENDER = "noreply@example.com" }
    policy_statements = [
      {
        Sid      = "ConsumeNotifications"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = ["arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications"]
      },
      {
        Sid       = "SendFromSender"
        Effect    = "Allow"
        Action    = ["ses:SendEmail"]
        Resource  = ["arn:aws:ses:af-south-1:123456789012:identity/noreply@example.com"]
        Condition = { StringEquals = { "ses:FromAddress" = ["noreply@example.com"] } }
      },
      {
        Sid       = "ReadClientSecret"
        Effect    = "Allow"
        Action    = ["secretsmanager:GetSecretValue"]
        Resource  = ["arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-notifier-AbCdEf"]
        Condition = { ArnLike = { "aws:SourceArn" = ["arn:aws:lambda:af-south-1:123456789012:function:cd-dispute-notifier", "arn:aws:lambda:af-south-1:123456789012:function:cd-dispute-notifier:*"] } }
      },
    ]
  }

  assert {
    condition = [for s in jsondecode(aws_iam_role_policy.function.policy).Statement : s if contains(["ConsumeNotifications", "SendFromSender", "ReadClientSecret"], s.Sid)] == [
      {
        Sid      = "ConsumeNotifications", Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = ["arn:aws:sqs:af-south-1:123456789012:cd-dispute-notifications"]
      },
      {
        Sid       = "SendFromSender", Effect = "Allow", Action = ["ses:SendEmail"]
        Resource  = ["arn:aws:ses:af-south-1:123456789012:identity/noreply@example.com"]
        Condition = { StringEquals = { "ses:FromAddress" = ["noreply@example.com"] } }
      },
      {
        Sid       = "ReadClientSecret", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"]
        Resource  = ["arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/svc-notifier-AbCdEf"]
        Condition = { ArnLike = { "aws:SourceArn" = ["arn:aws:lambda:af-south-1:123456789012:function:cd-dispute-notifier", "arn:aws:lambda:af-south-1:123456789012:function:cd-dispute-notifier:*"] } }
      },
    ]
    error_message = "A list mixing no Condition, StringEquals and ArnLike renders as given; no null Condition key."
  }
}
