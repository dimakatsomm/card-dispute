variable "name_prefix" {
  description = "Prefix for every resource name (cd)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.name_prefix))
    error_message = "name_prefix must be 2-16 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "edge_origin_mode" {
  description = "vpc_origin: CloudFront VPC origin on the internal ALB. public_alb: custom origin on the public ALB with a secret header (ADR-059/063 fallback)."
  type        = string

  validation {
    condition     = contains(["vpc_origin", "public_alb"], var.edge_origin_mode)
    error_message = "edge_origin_mode must be vpc_origin or public_alb."
  }
}

variable "alb_arn" {
  description = "ALB ARN; the VPC origin endpoint in vpc_origin mode."
  type        = string
}

variable "alb_dns_name" {
  description = "ALB DNS name, the origin domain for both origins."
  type        = string
}

variable "alb_security_group_id" {
  description = "The alb security group; edge owns its :80 ingress rule from CloudFront."
  type        = string
}

variable "origin_secret_header_value" {
  description = "x-cd-origin-secret value from alb (public_alb only, null in vpc_origin)."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = (var.edge_origin_mode == "public_alb") == (var.origin_secret_header_value != null)
    error_message = "origin_secret_header_value is required in public_alb and must be null in vpc_origin."
  }
}

variable "waf_rate_limit" {
  description = "Requests per 5 minutes per client IP before the WAF rate rule blocks."
  type        = number
  default     = 2000

  validation {
    condition     = var.waf_rate_limit >= 100 && var.waf_rate_limit <= 2000000000 && floor(var.waf_rate_limit) == var.waf_rate_limit
    error_message = "waf_rate_limit must be a whole number between 100 and 2000000000."
  }
}
