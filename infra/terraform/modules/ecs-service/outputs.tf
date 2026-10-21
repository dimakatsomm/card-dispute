output "service_name" {
  description = "ECS service name, cd-<svc>."
  value       = aws_ecs_service.this.name
}

output "service_arn" {
  description = "ECS service ARN (deploy role scope)."
  value       = aws_ecs_service.this.id
}

output "task_definition_family" {
  description = "Service task definition family, cd-<svc>."
  value       = aws_ecs_task_definition.service.family
}

output "migrate_task_definition_family" {
  description = "Migration task definition family cd-<svc>-migrate, or null when migrate is null."
  value       = local.migrate_enabled ? aws_ecs_task_definition.migrate[0].family : null
}

output "task_role_arn" {
  description = "Task role ARN (PassRole for the deploy role; SQS sender for disputes)."
  value       = aws_iam_role.task.arn
}

output "task_role_name" {
  description = "Task role name."
  value       = aws_iam_role.task.name
}

output "execution_role_arn" {
  description = "Execution role ARN, shared by the service and migrate task definitions (PassRole for the deploy role)."
  value       = aws_iam_role.execution.arn
}

output "log_group_name" {
  description = "Log group /cd/dev/ecs/<svc> (service, migrate and service-connect stream prefixes)."
  value       = aws_cloudwatch_log_group.this.name
}
