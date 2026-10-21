output "cluster_arn" {
  description = "Aurora cluster ARN."
  value       = aws_rds_cluster.this.arn
}

output "cluster_identifier" {
  description = "Cluster identifier (CloudWatch DBClusterIdentifier dimension)."
  value       = aws_rds_cluster.this.cluster_identifier
}

output "cluster_resource_id" {
  description = "Cluster resource id (cluster-XXXX), for resource-id scoped IAM or alarms."
  value       = aws_rds_cluster.this.cluster_resource_id
}

output "endpoint" {
  description = "Writer endpoint hostname."
  value       = aws_rds_cluster.this.endpoint
}

output "port" {
  description = "PostgreSQL port."
  value       = aws_rds_cluster.this.port
}

output "database_name" {
  description = "Application database name."
  value       = aws_rds_cluster.this.database_name
}

output "master_secret_arn" {
  description = "RDS-managed master secret ARN (JSON keys username, password only)."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "role_secret_arns" {
  description = "DB role key -> secret ARN of cd/dev/db/<role> (JSON username, password, host, port, dbname, url)."
  value       = { for role, secret in aws_secretsmanager_secret.role : role => secret.arn }
}
