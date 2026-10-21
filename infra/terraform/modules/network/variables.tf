variable "name_prefix" {
  description = "Prefix for every resource name (cd-<component>)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.name_prefix))
    error_message = "name_prefix must be 2-10 lowercase alphanumerics starting with a letter."
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR block; subnets are /+4 slices of it (public at index 0..n-1, private at 8..8+n-1)."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid IPv4 CIDR of /20 or larger."
  }
}

variable "az_count" {
  description = "Number of availability zones, with one public and one private subnet each."
  type        = number
  default     = 2

  validation {
    condition     = contains([2, 3], var.az_count)
    error_message = "az_count must be 2 or 3."
  }
}

variable "enable_flow_logs" {
  description = "Send VPC flow logs (ALL traffic) to CloudWatch Logs. Off by default to keep dev cost down."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Retention of the flow log group (used only when enable_flow_logs is true)."
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be one of 1, 3, 5, 7, 14, 30."
  }
}

variable "logs_kms_key_arn" {
  description = "KMS key (cd-data) for the flow log group; null falls back to CloudWatch default encryption."
  type        = string
  default     = null
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary for the flow log delivery role (used only when enable_flow_logs is true)."
  type        = string
  default     = null
}

variable "iam_path" {
  description = "IAM path for the flow log delivery role."
  type        = string
  default     = "/cd/"

  validation {
    condition     = can(regex("^/([A-Za-z0-9_+=,.@-]+/)*$", var.iam_path))
    error_message = "iam_path must start and end with a slash."
  }
}
