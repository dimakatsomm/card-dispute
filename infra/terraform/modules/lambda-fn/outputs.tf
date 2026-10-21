output "function_name" {
  description = "Function name cd-<key>, or null when image_uri is null."
  value       = local.create_function ? aws_lambda_function.this[0].function_name : null
}

output "function_arn" {
  description = "Unqualified function ARN, or null when image_uri is null."
  value       = local.create_function ? aws_lambda_function.this[0].arn : null
}

output "alias_name" {
  description = "Alias name live, or null when image_uri is null."
  value       = local.create_function ? aws_lambda_alias.live[0].name : null
}

output "alias_arn" {
  description = "ARN of the live alias (EventBridge, Scheduler and ESM target), or null when image_uri is null."
  value       = local.create_function ? aws_lambda_alias.live[0].arn : null
}

output "role_arn" {
  description = "Function execution role ARN (always created; notifier -> messaging allowed_consumer_role_arns)."
  value       = aws_iam_role.function.arn
}

output "role_name" {
  description = "Function execution role name."
  value       = aws_iam_role.function.name
}

output "log_group_name" {
  description = "Log group /aws/lambda/cd-<key>."
  value       = aws_cloudwatch_log_group.this.name
}

output "scheduler_role_arn" {
  description = "EventBridge Scheduler execution role ARN (messaging retention_scheduler_role_arns), or null when schedule is null."
  value       = local.has_schedule ? aws_iam_role.scheduler[0].arn : null
}
