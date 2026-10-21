output "alb_arn" {
  description = "ALB ARN (internal in vpc_origin, public in public_alb)."
  value       = aws_lb.this.arn
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix, the LoadBalancer CloudWatch dimension."
  value       = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  description = "ALB DNS name."
  value       = aws_lb.this.dns_name
}

output "web_listener_arn" {
  description = "Listener :80."
  value       = aws_lb_listener.web.arn
}

output "service_listener_arn" {
  description = "Listener :8081, or null in public_alb."
  value       = local.vpc_origin ? aws_lb_listener.service[0].arn : null
}

output "target_group_arns" {
  description = "Target group ARN by <svc>-<port>."
  value       = { for k, tg in aws_lb_target_group.this : k => tg.arn }
}

output "target_group_arn_suffixes" {
  description = "Target group ARN suffix (TargetGroup CloudWatch dimension) by <svc>-<port>."
  value       = { for k, tg in aws_lb_target_group.this : k => tg.arn_suffix }
}

output "service_port_base_url" {
  description = "http://<alb_dns_name>:8081 for the Lambdas, or null in public_alb."
  value       = local.vpc_origin ? "http://${aws_lb.this.dns_name}:8081" : null
}

output "origin_secret_header_value" {
  description = "x-cd-origin-secret value for edge; null in vpc_origin."
  value       = local.vpc_origin ? null : random_password.origin_secret[0].result
  sensitive   = true
}

output "origin_secret_arn" {
  description = "Secrets Manager ARN of cd/dev/edge/origin-secret, or null in vpc_origin."
  value       = local.vpc_origin ? null : aws_secretsmanager_secret.origin_secret[0].arn
}
