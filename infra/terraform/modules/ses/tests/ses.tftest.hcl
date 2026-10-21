mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_region" {
    defaults = { region = "af-south-1" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:af-south-1:123456789012:cd-ses-events"
      id  = "https://sqs.af-south-1.amazonaws.com/123456789012/cd-ses-events"
      url = "https://sqs.af-south-1.amazonaws.com/123456789012/cd-ses-events"
    }
  }

  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:af-south-1:123456789012:rule/cd-ses-events" }
  }
}

variables {
  name_prefix  = "cd"
  sender_email = "dimakatsomm@icloud.com"
  kms_key_arn  = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
}

run "identity_uses_the_configuration_set" {
  command = apply

  assert {
    condition     = aws_sesv2_email_identity.sender.email_identity == "dimakatsomm@icloud.com"
    error_message = "The identity must be the configured sender address."
  }

  assert {
    condition     = aws_sesv2_email_identity.sender.configuration_set_name == aws_sesv2_configuration_set.this.configuration_set_name
    error_message = "The configuration set must be the identity default."
  }

  assert {
    condition     = aws_sesv2_configuration_set.this.delivery_options[0].tls_policy == "REQUIRE"
    error_message = "Delivery must require TLS."
  }
}

run "destination_targets_the_default_event_bus" {
  command = apply

  assert {
    condition     = aws_sesv2_configuration_set_event_destination.eventbridge.event_destination[0].event_bridge_destination[0].event_bus_arn == "arn:aws:events:af-south-1:123456789012:event-bus/default"
    error_message = "Events must go to the default EventBridge bus."
  }

  assert {
    condition     = toset(aws_sesv2_configuration_set_event_destination.eventbridge.event_destination[0].matching_event_types) == toset(["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT"])
    error_message = "The destination must match SEND, DELIVERY, BOUNCE, COMPLAINT and REJECT."
  }

  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.ses_events.event_pattern) == {
      source = ["aws.ses"]
      detail = { mail = { tags = { "ses:configuration-set" = ["cd-email"] } } }
    }
    error_message = "The rule must match only SES events of this configuration set."
  }

  assert {
    condition     = aws_cloudwatch_event_target.ses_events.arn == aws_sqs_queue.ses_events.arn
    error_message = "The rule must target the ses-events queue."
  }
}

run "queue_is_short_lived_encrypted_and_rule_only" {
  command = apply

  assert {
    condition     = aws_sqs_queue.ses_events.message_retention_seconds == 86400 && aws_sqs_queue.ses_events.kms_master_key_id == var.kms_key_arn
    error_message = "ses-events must keep messages 1 day with SSE-KMS cd-data."
  }

  assert {
    condition = [for s in jsondecode(aws_sqs_queue_policy.ses_events.policy).Statement : {
      principal  = s.Principal
      source_arn = s.Condition.ArnEquals["aws:SourceArn"]
      } if s.Effect == "Allow"] == [{
      principal  = { Service = "events.amazonaws.com" }
      source_arn = "arn:aws:events:af-south-1:123456789012:rule/cd-ses-events"
    }]
    error_message = "The only Allow must be EventBridge for the ses-events rule."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.ses_events.policy).Statement : s
    if s.Sid == "DenySendExceptSesEventsRule"]).Condition.ArnNotEquals["aws:SourceArn"] == aws_cloudwatch_event_rule.ses_events.arn
    error_message = "Sends not from the ses-events rule must be denied."
  }

  assert {
    condition = one([for s in jsondecode(aws_sqs_queue_policy.ses_events.policy).Statement : s
    if s.Sid == "DenyNonTls"]).Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "The queue must deny non-TLS access."
  }
}
