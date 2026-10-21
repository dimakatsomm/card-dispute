variable "name_prefix" {
  description = "Prefix for every resource name (cd)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.name_prefix))
    error_message = "name_prefix must be 2-16 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "edge_origin_mode" {
  description = "vpc_origin: internal ALB with :80 (CloudFront VPC origin) and :8081 (Lambdas). public_alb: public ALB with :80 only, gated by a secret origin header (ADR-059/063 fallback)."
  type        = string

  validation {
    condition     = contains(["vpc_origin", "public_alb"], var.edge_origin_mode)
    error_message = "edge_origin_mode must be vpc_origin or public_alb."
  }
}

variable "vpc_id" {
  description = "VPC for the target groups."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets; used only by the public_alb fallback."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "An ALB needs subnets in at least two AZs."
  }
}

variable "private_subnet_ids" {
  description = "Private subnets for the internal ALB (vpc_origin)."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "An ALB needs subnets in at least two AZs."
  }
}

variable "security_group_id" {
  description = "The alb security group from the security module."
  type        = string
}

variable "data_kms_key_arn" {
  description = "cd-data key that encrypts the origin secret (public_alb only)."
  type        = string
}

variable "deletion_protection" {
  description = "Deletion protection on the ALB."
  type        = bool
  default     = true
}
