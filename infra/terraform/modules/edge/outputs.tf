output "distribution_id" {
  description = "CloudFront distribution id."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.this.arn
}

output "distribution_domain_name" {
  description = "dxxxx.cloudfront.net hostname of the distribution."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "web_origin" {
  description = "https://<distribution_domain_name>, no trailing slash (Cognito callbacks, S3 CORS, web OIDC_* env)."
  value       = "https://${aws_cloudfront_distribution.this.domain_name}"
}

output "web_acl_arn" {
  description = "WAF web ACL (us-east-1, scope CLOUDFRONT) attached to the distribution."
  value       = aws_wafv2_web_acl.this.arn
}
