output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs_cluster.cluster_name
}

output "ecs_service_names" {
  description = "ECS service name by service key."
  value       = { for k, s in module.service : k => s.service_name }
}

output "migrate_task_definition_families" {
  description = "One-off migration task family by service key (web has none)."
  value       = { for k, s in module.service : k => s.migrate_task_definition_family if s.migrate_task_definition_family != null }
}

output "ecr_repository_urls" {
  description = "ECR repository URL by repo key."
  value       = module.ecr.repository_urls
}

output "lambda_function_names" {
  description = "Lambda function name by key; null until the key is in lambda_image_uris (phase B)."
  value       = { for k, l in module.lambda : k => l.function_name }
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id (cache invalidation)."
  value       = module.edge.distribution_id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain the app is served on."
  value       = module.edge.distribution_domain_name
}

output "web_origin" {
  description = "Public app URL (https://<cloudfront domain>)."
  value       = module.edge.web_origin
}

output "cognito_user_pool_id" {
  description = "Cognito user pool id."
  value       = module.cognito.user_pool_id
}

output "cognito_spa_client_id" {
  description = "SPA app client id (public PKCE client, not a secret)."
  value       = module.cognito.spa_client_id
}

output "cognito_e2e_client_id" {
  description = "e2e app client id, or null when enable_e2e_client is false."
  value       = module.cognito.e2e_client_id
}

output "cognito_issuer_url" {
  description = "OIDC issuer URL."
  value       = module.cognito.issuer_url
}

output "cognito_hosted_ui_base_url" {
  description = "Cognito hosted UI base URL."
  value       = module.cognito.hosted_ui_base_url
}

output "ci_role_arns" {
  description = "GitHub OIDC role ARNs by key (publish-*, deploy-*, deploy-lambda-*, run-tools, e2e)."
  value       = module.ci_roles.role_arns
}

output "dev_tools_task_definition_families" {
  description = "dev-tools task family by tool key."
  value       = module.dev_tools.task_definition_families
}

output "dev_tools_run_task_network" {
  description = "Cluster, private subnets and dev-tools SG for RunTask."
  value       = module.dev_tools.run_task_network
}

output "dispute_notifier_security_group_id" {
  description = "Notifier SG for the second net-probe run (ADR-067)."
  value       = module.security.security_group_ids["dispute-notifier"]
}

output "quarantine_bucket_name" {
  description = "Evidence quarantine bucket."
  value       = module.evidence_buckets.quarantine_bucket_name
}

output "evidence_bucket_name" {
  description = "Promoted evidence bucket."
  value       = module.evidence_buckets.evidence_bucket_name
}

output "notifications_queue_url" {
  description = "Dispute notifications queue URL."
  value       = module.messaging.notifications_queue_url
}

output "dlq_names" {
  description = "DLQ name by key (runbook redrive)."
  value       = module.messaging.dlq_names
}

output "ses_events_queue_url" {
  description = "SES delivery events queue (E-03 checks)."
  value       = module.ses.ses_events_queue_url
}

output "aurora_cluster_identifier" {
  description = "Aurora cluster identifier."
  value       = module.aurora.cluster_identifier
}

output "alarm_topic_arn" {
  description = "SNS alarm topic."
  value       = module.observability.alarm_topic_arn
}

output "nat_public_ip" {
  description = "NAT gateway egress IP."
  value       = module.network.nat_public_ip
}
