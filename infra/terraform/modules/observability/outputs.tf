output "alarm_topic_arn" {
  description = "ARN of the cd-alarms SNS topic."
  value       = aws_sns_topic.alarms.arn
}

output "dashboard_name" {
  description = "CloudWatch dashboard name (cd-dev)."
  value       = aws_cloudwatch_dashboard.main.dashboard_name
}

output "budget_name" {
  description = "Name of the monthly cost budget."
  value       = aws_budgets_budget.monthly.name
}

output "alarm_arns" {
  description = "Alarm key to CloudWatch alarm ARN."
  value = merge(
    { for key, alarm in aws_cloudwatch_metric_alarm.metric : key => alarm.arn },
    { "event-publish-failed" = aws_cloudwatch_metric_alarm.event_publish_failed.arn },
  )
}
