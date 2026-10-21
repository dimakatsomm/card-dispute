output "notifications_queue_url" {
  description = "URL of the dispute-notifications queue (disputes NOTIFICATIONS_QUEUE_URL)."
  value       = aws_sqs_queue.notifications.url
}

output "notifications_queue_arn" {
  description = "ARN of the dispute-notifications queue (notifier event source)."
  value       = aws_sqs_queue.notifications.arn
}

output "notifications_dlq_arn" {
  description = "ARN of the dispute-notifications DLQ."
  value       = aws_sqs_queue.notifications_dlq.arn
}

output "evidence_intake_dlq_arn" {
  description = "ARN of the evidence-intake DLQ (scan rule target DLQ and intake async on-failure destination)."
  value       = aws_sqs_queue.evidence_intake_dlq.arn
}

output "retention_scheduler_dlq_arn" {
  description = "ARN of the retention-sweeper schedule DLQ."
  value       = aws_sqs_queue.retention_scheduler_dlq.arn
}

output "dlq_names" {
  description = "DLQ key (notifications, evidence-intake, retention-scheduler) to queue name, for DLQ depth alarms."
  value = {
    notifications       = aws_sqs_queue.notifications_dlq.name
    evidence-intake     = aws_sqs_queue.evidence_intake_dlq.name
    retention-scheduler = aws_sqs_queue.retention_scheduler_dlq.name
  }
}
