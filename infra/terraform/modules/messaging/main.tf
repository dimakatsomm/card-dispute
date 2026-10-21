data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  notifications_name = "${var.name_prefix}-dispute-notifications"

  dlq_names = {
    notifications       = "${local.notifications_name}-dlq"
    evidence-intake     = "${var.name_prefix}-evidence-intake-dlq"
    retention-scheduler = "${var.name_prefix}-retention-scheduler-dlq"
  }

  four_days_seconds     = 4 * 24 * 60 * 60
  fourteen_days_seconds = 14 * 24 * 60 * 60

  # Enumerated instead of sqs:* (no service wildcards in Action).
  all_sqs_actions = [
    "sqs:AddPermission",
    "sqs:CancelMessageMoveTask",
    "sqs:ChangeMessageVisibility",
    "sqs:DeleteMessage",
    "sqs:DeleteQueue",
    "sqs:GetQueueAttributes",
    "sqs:GetQueueUrl",
    "sqs:ListDeadLetterSourceQueues",
    "sqs:ListMessageMoveTasks",
    "sqs:ListQueueTags",
    "sqs:PurgeQueue",
    "sqs:ReceiveMessage",
    "sqs:RemovePermission",
    "sqs:SendMessage",
    "sqs:SetQueueAttributes",
    "sqs:StartMessageMoveTask",
    "sqs:TagQueue",
    "sqs:UntagQueue",
  ]

  consume_actions = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"]

  deny_non_tls = {
    for key, arn in {
      notifications       = aws_sqs_queue.notifications.arn
      notifications-dlq   = aws_sqs_queue.notifications_dlq.arn
      evidence-intake     = aws_sqs_queue.evidence_intake_dlq.arn
      retention-scheduler = aws_sqs_queue.retention_scheduler_dlq.arn
      } : key => {
      Sid       = "DenyNonTls"
      Effect    = "Deny"
      Principal = "*"
      Action    = local.all_sqs_actions
      Resource  = [arn]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }
  }

  account_root_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
  has_operators    = length(var.redrive_operator_arns) > 0

  notifications_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [local.deny_non_tls["notifications"]],
      [{
        Sid       = "AllowDisputesSend"
        Effect    = "Allow"
        Principal = { AWS = var.allowed_sender_role_arns }
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.notifications.arn]
      }],
      # A message move task sends as the caller and no condition key tells it apart from SendMessage.
      local.has_operators ? [{
        Sid       = "AllowRedriveOperatorSend"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.notifications.arn]
        Condition = { ArnLike = { "aws:PrincipalArn" = var.redrive_operator_arns } }
      }] : [],
      [{
        Sid       = "DenySendExceptDisputesAndOperators"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.notifications.arn]
        Condition = { ArnNotLike = { "aws:PrincipalArn" = concat(var.allowed_sender_role_arns, var.redrive_operator_arns) } }
      }],
      [{
        Sid       = "AllowNotifierConsume"
        Effect    = "Allow"
        Principal = { AWS = var.allowed_consumer_role_arns }
        Action    = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource  = [aws_sqs_queue.notifications.arn]
      }],
      [{
        Sid       = "DenyConsumeExceptNotifier"
        Effect    = "Deny"
        Principal = "*"
        Action    = local.consume_actions
        Resource  = [aws_sqs_queue.notifications.arn]
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.allowed_consumer_role_arns } }
      }],
    )
  }

  # Messages arrive only via redrive from the notifications queue, which is not a principal call.
  notifications_dlq_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [local.deny_non_tls["notifications-dlq"]],
      local.has_operators ? [{
        Sid       = "AllowRedriveOperatorMove"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action = [
          "sqs:StartMessageMoveTask",
          "sqs:ListMessageMoveTasks",
          "sqs:CancelMessageMoveTask",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource  = [aws_sqs_queue.notifications_dlq.arn]
        Condition = { ArnLike = { "aws:PrincipalArn" = var.redrive_operator_arns } }
      }] : [],
    )
  }

  evidence_intake_dlq_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [local.deny_non_tls["evidence-intake"]],
      [{
        Sid       = "AllowScanRuleTargetDlq"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.evidence_intake_dlq.arn]
        Condition = { ArnEquals = { "aws:SourceArn" = var.evidence_scan_rule_arn } }
      }],
      [{
        Sid       = "AllowIntakeOnFailure"
        Effect    = "Allow"
        Principal = { AWS = var.evidence_intake_role_arns }
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.evidence_intake_dlq.arn]
      }],
      [{
        Sid       = "DenySendExceptProducers"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.evidence_intake_dlq.arn]
        Condition = {
          ArnNotEquals = {
            "aws:SourceArn"    = [var.evidence_scan_rule_arn]
            "aws:PrincipalArn" = var.evidence_intake_role_arns
          }
        }
      }],
    )
  }

  # Scheduler delivers to its DLQ with the schedule's execution role, not a service principal.
  retention_scheduler_dlq_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [local.deny_non_tls["retention-scheduler"]],
      [{
        Sid       = "AllowSchedulerDlqSend"
        Effect    = "Allow"
        Principal = { AWS = var.retention_scheduler_role_arns }
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.retention_scheduler_dlq.arn]
      }],
      [{
        Sid       = "DenySendExceptScheduler"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.retention_scheduler_dlq.arn]
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.retention_scheduler_role_arns } }
      }],
    )
  }
}

resource "aws_sqs_queue" "notifications_dlq" {
  name                      = local.dlq_names["notifications"]
  message_retention_seconds = local.fourteen_days_seconds
  kms_master_key_id         = var.kms_key_arn
  tags                      = { component = "messaging" }
}

resource "aws_sqs_queue" "notifications" {
  name                       = local.notifications_name
  message_retention_seconds  = local.four_days_seconds
  visibility_timeout_seconds = 6 * var.notifier_timeout_seconds
  kms_master_key_id          = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notifications_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = { component = "messaging" }
}

resource "aws_sqs_queue" "evidence_intake_dlq" {
  name                      = local.dlq_names["evidence-intake"]
  message_retention_seconds = local.fourteen_days_seconds
  kms_master_key_id         = var.kms_key_arn
  tags                      = { component = "messaging" }
}

resource "aws_sqs_queue" "retention_scheduler_dlq" {
  name                      = local.dlq_names["retention-scheduler"]
  message_retention_seconds = local.fourteen_days_seconds
  kms_master_key_id         = var.kms_key_arn
  tags                      = { component = "messaging" }
}

resource "aws_sqs_queue_redrive_allow_policy" "notifications_dlq" {
  queue_url = aws_sqs_queue.notifications_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.notifications.arn]
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "evidence_intake_dlq" {
  queue_url            = aws_sqs_queue.evidence_intake_dlq.id
  redrive_allow_policy = jsonencode({ redrivePermission = "denyAll" })
}

resource "aws_sqs_queue_redrive_allow_policy" "retention_scheduler_dlq" {
  queue_url            = aws_sqs_queue.retention_scheduler_dlq.id
  redrive_allow_policy = jsonencode({ redrivePermission = "denyAll" })
}

resource "aws_sqs_queue_policy" "notifications" {
  queue_url = aws_sqs_queue.notifications.id
  policy    = jsonencode(local.notifications_policy)
}

resource "aws_sqs_queue_policy" "notifications_dlq" {
  queue_url = aws_sqs_queue.notifications_dlq.id
  policy    = jsonencode(local.notifications_dlq_policy)
}

resource "aws_sqs_queue_policy" "evidence_intake_dlq" {
  queue_url = aws_sqs_queue.evidence_intake_dlq.id
  policy    = jsonencode(local.evidence_intake_dlq_policy)
}

resource "aws_sqs_queue_policy" "retention_scheduler_dlq" {
  queue_url = aws_sqs_queue.retention_scheduler_dlq.id
  policy    = jsonencode(local.retention_scheduler_dlq_policy)
}
