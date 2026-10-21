output "role_arns" {
  description = "CI role ARN by key: publish-<repo key>, deploy-<svc>, deploy-lambda-<key>, run-tools, e2e."
  value       = { for k, r in aws_iam_role.this : k => r.arn }
}
