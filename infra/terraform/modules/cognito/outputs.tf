output "user_pool_id" {
  description = "User pool id."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "User pool ARN."
  value       = aws_cognito_user_pool.this.arn
}

output "issuer_url" {
  description = "Token iss and OIDC discovery base (AUTH_ISSUER_URL, OIDC_ISSUER)."
  value       = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}

output "jwks_url" {
  description = "JWKS endpoint (AUTH_JWKS_URI)."
  value       = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/jwks.json"
}

output "hosted_ui_base_url" {
  description = "Hosted UI / OAuth endpoints origin (OIDC_TOKEN_ORIGIN; /logout for OIDC_LOGOUT_URL)."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${local.region}.amazoncognito.com"
}

output "token_url" {
  description = "OAuth2 token endpoint for client_credentials (TOKEN_URL)."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${local.region}.amazoncognito.com/oauth2/token"
}

output "spa_client_id" {
  description = "SPA client id (OIDC_CLIENT_ID)."
  value       = aws_cognito_user_pool_client.spa.id
}

output "e2e_client_id" {
  description = "e2e client id, or null when enable_e2e_client is false."
  value       = one(aws_cognito_user_pool_client.e2e[*].id)
}

output "user_client_ids" {
  description = "User-token client ids: spa (+ e2e) (AUTH_USER_CLIENT_IDS)."
  value       = concat([aws_cognito_user_pool_client.spa.id], aws_cognito_user_pool_client.e2e[*].id)
}

output "service_client_ids" {
  description = "Service client key (grants.json) to client id (AUTH_SERVICE_CLIENT_IDS = values)."
  value       = { for k, c in aws_cognito_user_pool_client.service : k => c.id }
}

output "service_client_secret_arns" {
  description = "Service client key to Secrets Manager ARN holding the raw client secret."
  value       = { for k, s in aws_secretsmanager_secret.service_client : k => s.arn }
}
