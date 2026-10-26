data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  configuration_set_name = "${var.name_prefix}-email"
  ses_events_name        = "${var.name_prefix}-ses-events"
  default_event_bus_arn  = "arn:${data.aws_partition.current.partition}:events:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:event-bus/default"
  event_types            = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT"]

  ses_events_queue_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonTls"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["sqs:*"]
        Resource  = [aws_sqs_queue.ses_events.arn]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "AllowSesEventsRule"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.ses_events.arn]
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.ses_events.arn } }
      },
      {
        Sid       = "DenySendExceptSesEventsRule"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["sqs:SendMessage"]
        Resource  = [aws_sqs_queue.ses_events.arn]
        Condition = { ArnNotEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.ses_events.arn } }
      },
    ]
  }
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = local.configuration_set_name

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  tags = { component = "ses" }
}

resource "aws_sesv2_configuration_set_event_destination" "eventbridge" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "eventbridge-default-bus"

  event_destination {
    enabled              = true
    matching_event_types = local.event_types

    event_bridge_destination {
      event_bus_arn = local.default_event_bus_arn
    }
  }
}

resource "aws_sesv2_email_identity" "sender" {
  email_identity         = var.sender_email
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  tags                   = { component = "ses" }
}

resource "aws_sqs_queue" "ses_events" {
  name                      = local.ses_events_name
  message_retention_seconds = var.events_retention_seconds
  kms_master_key_id         = var.kms_key_arn
  tags                      = { component = "ses" }
}

resource "aws_cloudwatch_event_rule" "ses_events" {
  name        = local.ses_events_name
  description = "SES events of the ${local.configuration_set_name} configuration set, for E-03 delivery checks."

  event_pattern = jsonencode({
    source = ["aws.ses"]
    detail = { mail = { tags = { "ses:configuration-set" = [local.configuration_set_name] } } }
  })

  tags = { component = "ses" }
}

resource "aws_cloudwatch_event_target" "ses_events" {
  rule      = aws_cloudwatch_event_rule.ses_events.name
  target_id = "ses-events-queue"
  arn       = aws_sqs_queue.ses_events.arn
}

resource "aws_sqs_queue_policy" "ses_events" {
  queue_url = aws_sqs_queue.ses_events.id
  policy    = jsonencode(local.ses_events_queue_policy)
}
