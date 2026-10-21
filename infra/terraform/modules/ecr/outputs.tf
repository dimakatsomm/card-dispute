output "repository_urls" {
  description = "Repo key to repository URL (<acct>.dkr.ecr.<region>.amazonaws.com/cd-<key>)."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "repository_arns" {
  description = "Repo key to repository ARN."
  value       = { for k, r in aws_ecr_repository.this : k => r.arn }
}

output "repository_names" {
  description = "Repo key to repository name (cd-<key>)."
  value       = { for k, r in aws_ecr_repository.this : k => r.name }
}
