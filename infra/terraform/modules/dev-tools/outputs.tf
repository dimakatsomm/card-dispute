output "task_definition_families" {
  description = "Tool key -> task definition family (cd-db-bootstrap, cd-dev-seed, cd-net-probe)."
  value       = { for k, td in aws_ecs_task_definition.this : k => td.family }
}

output "task_definition_arns" {
  description = "Tool key -> Terraform-registered task definition revision ARN."
  value       = { for k, td in aws_ecs_task_definition.this : k => td.arn }
}

output "task_role_arns" {
  description = "Tool key -> task role ARN, for ci-roles PassRole; db-bootstrap has none and is absent."
  value       = { for k, r in aws_iam_role.task : k => r.arn }
}

output "execution_role_arns" {
  description = "Tool key -> execution role ARN, for ci-roles PassRole."
  value       = { for k, r in aws_iam_role.execution : k => r.arn }
}

output "log_group_names" {
  description = "Tool key -> log group name (/cd/dev/tools/<tool>)."
  value       = { for k, lg in aws_cloudwatch_log_group.this : k => lg.name }
}

output "run_task_network" {
  description = "Cluster, private subnets and dev-tools SG for RunTask (runbook, dev-tools pipeline); no public IP."
  value = {
    cluster_arn       = var.cluster_arn
    subnet_ids        = var.subnet_ids
    security_group_id = var.security_group_id
    assign_public_ip  = false
  }
}
