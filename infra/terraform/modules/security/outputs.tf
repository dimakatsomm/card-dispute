output "kms_key_arns" {
  description = "KMS key ARNs by key: data (Aurora, Secrets Manager, SQS, logs, SNS, ECR), evidence (quarantine + evidence buckets)."
  value       = { for k, key in aws_kms_key.this : k => key.arn }
}

output "security_group_ids" {
  description = "Security group ids by key: alb, auth, users, transactions, disputes, web, evidence-intake, dispute-notifier, retention-sweeper, aurora, dev-tools."
  value       = { for k, sg in aws_security_group.this : k => sg.id }
}
