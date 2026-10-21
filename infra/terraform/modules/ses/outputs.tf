output "email_identity_arn" {
  description = "ARN of the sender email identity (resource of the notifier ses:SendEmail statement)."
  value       = aws_sesv2_email_identity.sender.arn
}

output "configuration_set_name" {
  description = "Configuration set name; it is the identity default, so the notifier need not pass it."
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "configuration_set_arn" {
  description = "ARN of the configuration set (resource of the notifier ses:SendEmail statement)."
  value       = aws_sesv2_configuration_set.this.arn
}

output "ses_events_queue_url" {
  description = "URL of the ses-events queue read by the E-03 delivery check."
  value       = aws_sqs_queue.ses_events.url
}

output "ses_events_queue_arn" {
  description = "ARN of the ses-events queue (ci-roles e2e receive/delete)."
  value       = aws_sqs_queue.ses_events.arn
}
