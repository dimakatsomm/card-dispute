output "state_bucket_name" {
  description = "State bucket for envs/dev -backend-config and stored plans (plans/<sha>)."
  value       = aws_s3_bucket.state.bucket
}

output "state_kms_key_arn" {
  description = "KMS key encrypting state and plans; pass as backend kms_key_id."
  value       = aws_kms_key.state.arn
}

output "github_oidc_provider_arn" {
  description = "IAM OIDC provider for token.actions.githubusercontent.com, audience sts.amazonaws.com."
  value       = aws_iam_openid_connect_provider.github.arn
}

output "infra_plan_role_arn" {
  description = "gha-infra-plan, trusted only for sub repo:<repo>:ref:refs/heads/main."
  value       = aws_iam_role.infra_plan.arn
}

output "infra_apply_role_arn" {
  description = "gha-infra-apply, trusted only for sub repo:<repo>:environment:dev-infra."
  value       = aws_iam_role.infra_apply.arn
}

output "permissions_boundary_arn" {
  description = "Policy cd-workload-boundary, required on every role the apply role creates."
  value       = aws_iam_policy.boundary.arn
}
