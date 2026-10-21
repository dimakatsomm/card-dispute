variable "name_prefix" {
  description = "Prefix for every resource name (cd)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.name_prefix))
    error_message = "name_prefix must be 2-16 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "vpc_id" {
  description = "VPC that holds every security group."
  type        = string
}

variable "s3_prefix_list_id" {
  description = "Prefix list of the S3 gateway endpoint, for explicit :443 egress to S3."
  type        = string
}

variable "edge_origin_mode" {
  description = "vpc_origin: Lambdas reach service ports through the internal ALB :8081. public_alb: no ALB :8081, Lambdas reach users/disputes directly via Cloud Map (ADR-059 fallback)."
  type        = string

  validation {
    condition     = contains(["vpc_origin", "public_alb"], var.edge_origin_mode)
    error_message = "edge_origin_mode must be vpc_origin or public_alb."
  }
}
