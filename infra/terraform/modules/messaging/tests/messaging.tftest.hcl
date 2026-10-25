mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
}

override_resource {
  target = aws_sqs_queue.notifications
  values = {
    arn = "arn:aws:sqs:eu-north-1:123456789012:cd-dispute-notifications"
    id  = "https://sqs.eu-north-1.amazonaws.com/123456789012/cd-dispute-notifications"
    url = "https://sqs.eu-north-1.amazonaws.com/123456789012/cd-dispute-notifications"
  }
}

override_resource {
  target = aws_sqs_queue.notifications_dlq
  values = {
    arn = "arn:aws:sqs:eu-north-1:123456789012:cd-dispute-notifications-dlq"
    id  = "https://sqs.eu-north-1.amazonaws.com/123456789012/cd-dispute-notifications-dlq"
  }
}

override_resource {
  target = aws_sqs_queue.evidence_intake_dlq
  values = {
    arn = "arn:aws:sqs:eu-north-1:123456789012:cd-evidence-intake-dlq"
    id  = "https://sqs.eu-north-1.amazonaws.com/123456789012/cd-evidence-intake-dlq"
  }
}

override_resource {
  target = aws_sqs_queue.retention_scheduler_dlq
  values = {
    arn = "arn:aws:sqs:eu-north-1:123456789012:cd-retention-scheduler-dlq"
    id  = "https://sqs.eu-north-1.amazonaws.com/123456789012/cd-retention-scheduler-dlq"
  }
}

variables {
  name_prefix                   = "cd"
  kms_key_arn                   = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  allowed_sender_role_arns      = ["arn:aws:iam::123456789012:role/cd/cd-disputes-task"]
  allowed_consumer_role_arns    = ["arn:aws:iam::123456789012:role/cd/cd-dispute-notifier-fn"]
  evidence_scan_rule_arn        = "arn:aws:events:eu-north-1:123456789012:rule/cd-evidence-scan-result"
  evidence_intake_role_arns     = ["arn:aws:iam::123456789012:role/cd/cd-evidence-intake-fn"]
  retention_scheduler_role_arns = ["arn:aws:iam::123456789012:role/cd/cd-retention-sweeper-scheduler"]
}

run "queues_redrive_encryption_and_retention" {
  command = apply

  assert {
    condition     = jsondecode(aws_sqs_queue.notifications.redrive_policy).maxReceiveCount == 5
    error_message = "Notifications redrive maxReceiveCount must be 5."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.notifications.redrive_policy).deadLetterTargetArn == aws_sqs_queue.notifications_dlq.arn
    error_message = "Notifications must redrive to its own DLQ."
  }

  assert {
    condition = alltrue([for q in [
      aws_sqs_queue.notifications,
      aws_sqs_queue.notifications_dlq,
      aws_sqs_queue.evidence_intake_dlq,
      aws_sqs_queue.retention_scheduler_dlq,
    ] : q.kms_master_key_id == var.kms_key_arn])
    error_message = "Every queue must use SSE-KMS with cd-data."
  }

  assert {
    condition     = aws_sqs_queue.notifications.visibility_timeout_seconds == 180
    error_message = "Default visibility must be 6 x the 30 s contract default."
  }

  assert {
    condition     = aws_sqs_queue.notifications.message_retention_seconds == 345600 && aws_sqs_queue.notifications_dlq.message_retention_seconds == 1209600
    error_message = "Retention must be 4 days on notifications and 14 days on its DLQ."
  }

  assert {
    condition     = output.dlq_names == { notifications = "cd-dispute-notifications-dlq", evidence-intake = "cd-evidence-intake-dlq", retention-scheduler = "cd-retention-scheduler-dlq" }
    error_message = "DLQ names must match the contract keys and names."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue_redrive_allow_policy.notifications_dlq.redrive_allow_policy).sourceQueueArns == [aws_sqs_queue.notifications.arn]
    error_message = "Only the notifications queue may use its DLQ."
  }
}

run "visibility_is_six_times_notifier_timeout" {
  command = apply

  variables {
    notifier_timeout_seconds = 40
  }

  assert {
    condition     = aws_sqs_queue.notifications.visibility_timeout_seconds == 240
    error_message = "Visibility must be 6 x notifier_timeout_seconds."
  }
}

run "notifications_send_and_consume_are_role_restricted" {
  command = apply

  assert {
    condition = [for s in jsondecode(aws_sqs_queue_policy.notifications.policy).Statement : s.Principal.AWS
    if s.Effect == "Allow" && contains(s.Action, "sqs:SendMessage")] == [["arn:aws:iam::123456789012:role/cd/cd-disputes-task"]]
    error_message = "Without operators, only the disputes task role may be allowed to send."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.notifications.policy).Statement : s
      if s.Sid == "DenySendExceptDisputesAndOperators"]).Condition.ArnNotLike["aws:PrincipalArn"] == [
    "arn:aws:iam::123456789012:role/cd/cd-disputes-task"]
    error_message = "SendMessage must be denied for every principal other than the disputes task role."
  }

  assert {
    condition = [for s in jsondecode(aws_sqs_queue_policy.notifications.policy).Statement : s.Principal.AWS
    if s.Effect == "Allow" && contains(s.Action, "sqs:ReceiveMessage")] == [["arn:aws:iam::123456789012:role/cd/cd-dispute-notifier-fn"]]
    error_message = "Only the notifier role may be allowed to receive."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.notifications.policy).Statement : s
      if s.Sid == "DenyConsumeExceptNotifier"]).Condition.ArnNotEquals["aws:PrincipalArn"] == [
    "arn:aws:iam::123456789012:role/cd/cd-dispute-notifier-fn"]
    error_message = "Receive/delete must be denied for every principal other than the notifier role."
  }

  assert {
    condition     = length(jsondecode(aws_sqs_queue_policy.notifications_dlq.policy).Statement) == 1
    error_message = "Without operators, the notifications DLQ grants nothing."
  }
}

run "redrive_operators_can_move_the_dlq_back" {
  command = apply

  variables {
    redrive_operator_arns = ["arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*"]
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.notifications.policy).Statement : s
      if s.Sid == "AllowRedriveOperatorSend"]) == {
      Sid       = "AllowRedriveOperatorSend"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::123456789012:root" }
      Action    = ["sqs:SendMessage"]
      Resource  = [aws_sqs_queue.notifications.arn]
      Condition = { ArnLike = { "aws:PrincipalArn" = ["arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*"] } }
    }
    error_message = "Operators may only send to the notifications queue, matched by principal ARN pattern."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.notifications.policy).Statement : s
      if s.Sid == "DenySendExceptDisputesAndOperators"]).Condition.ArnNotLike["aws:PrincipalArn"] == ["arn:aws:iam::123456789012:role/cd/cd-disputes-task",
    "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*"]
    error_message = "The send deny must exempt exactly the disputes role and the operators."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.notifications_dlq.policy).Statement : s
    if s.Sid == "AllowRedriveOperatorMove"]).Condition.ArnLike["aws:PrincipalArn"] == ["arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*"]
    error_message = "Only operators may start a move task on the DLQ."
  }

  assert {
    condition = toset(one([for s in jsondecode(aws_sqs_queue_policy.notifications_dlq.policy).Statement : s
      if s.Sid == "AllowRedriveOperatorMove"]).Action) == toset(["sqs:StartMessageMoveTask", "sqs:ListMessageMoveTasks",
    "sqs:CancelMessageMoveTask", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"])
    error_message = "The DLQ operator grant must be limited to the move-task actions."
  }
}

run "every_queue_denies_non_tls" {
  command = apply

  assert {
    condition = alltrue([for p in [
      aws_sqs_queue_policy.notifications.policy,
      aws_sqs_queue_policy.notifications_dlq.policy,
      aws_sqs_queue_policy.evidence_intake_dlq.policy,
      aws_sqs_queue_policy.retention_scheduler_dlq.policy,
      ] : anytrue([for s in jsondecode(p).Statement :
        s.Effect == "Deny" && s.Principal == "*" && try(s.Condition.Bool["aws:SecureTransport"], null) == "false"
    && contains(s.Action, "sqs:SendMessage") && contains(s.Action, "sqs:ReceiveMessage")])])
    error_message = "Every queue policy must deny non-TLS access."
  }
}

run "dlqs_accept_only_their_producers" {
  command = apply

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.evidence_intake_dlq.policy).Statement : s
    if s.Sid == "AllowScanRuleTargetDlq"]).Condition.ArnEquals["aws:SourceArn"] == var.evidence_scan_rule_arn
    error_message = "EventBridge may send to the intake DLQ only for the scan rule."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.evidence_intake_dlq.policy).Statement : s
      if s.Sid == "DenySendExceptProducers"]).Condition.ArnNotEquals == {
      "aws:SourceArn"    = [var.evidence_scan_rule_arn]
      "aws:PrincipalArn" = ["arn:aws:iam::123456789012:role/cd/cd-evidence-intake-fn"]
    }
    error_message = "The intake DLQ must deny every sender except the scan rule and the intake role."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.retention_scheduler_dlq.policy).Statement : s
      if s.Sid == "DenySendExceptScheduler"]).Condition.ArnNotEquals["aws:PrincipalArn"] == [
    "arn:aws:iam::123456789012:role/cd/cd-retention-sweeper-scheduler"]
    error_message = "The scheduler DLQ must deny every sender except the schedule role."
  }
}

run "rejects_empty_intake_role_list" {
  command = plan

  variables {
    evidence_intake_role_arns = []
  }

  expect_failures = [var.evidence_intake_role_arns]
}

run "rejects_empty_scheduler_role_list" {
  command = plan

  variables {
    retention_scheduler_role_arns = []
  }

  expect_failures = [var.retention_scheduler_role_arns]
}

run "rejects_empty_sender_list" {
  command = plan

  variables {
    allowed_sender_role_arns = []
  }

  expect_failures = [var.allowed_sender_role_arns]
}

run "rejects_empty_consumer_list" {
  command = plan

  variables {
    allowed_consumer_role_arns = []
  }

  expect_failures = [var.allowed_consumer_role_arns]
}

run "rejects_out_of_range_timeout" {
  command = plan

  variables {
    notifier_timeout_seconds = 901
  }

  expect_failures = [var.notifier_timeout_seconds]
}
