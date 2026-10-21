output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "cluster_name" {
  description = "ECS cluster name (cd-cluster)."
  value       = aws_ecs_cluster.this.name
}

output "namespace_arn" {
  description = "ARN of the cd.internal Cloud Map private DNS namespace."
  value       = aws_service_discovery_private_dns_namespace.this.arn
}

output "namespace_id" {
  description = "Id of the cd.internal Cloud Map namespace (for service registries)."
  value       = aws_service_discovery_private_dns_namespace.this.id
}

output "namespace_name" {
  description = "Namespace name, cd.internal."
  value       = aws_service_discovery_private_dns_namespace.this.name
}
