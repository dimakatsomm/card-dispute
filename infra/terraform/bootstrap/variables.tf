variable "github_repo" {
  description = "GitHub repository as owner/repo; pins the OIDC trust subjects of gha-infra-plan and gha-infra-apply."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$", var.github_repo))
    error_message = "github_repo must be \"owner/repo\"."
  }

  validation {
    condition     = !startswith(var.github_repo, "PLACEHOLDER/")
    error_message = "github_repo is still the placeholder; pass the real owner/repo."
  }
}

variable "name_prefix" {
  description = "Prefix the apply role and the permissions boundary are scoped to (cd-*, cd/*, /cd/ role path)."
  type        = string
  default     = "cd"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.name_prefix))
    error_message = "name_prefix must be 2-10 lowercase alphanumerics starting with a letter."
  }
}

variable "state_bucket_name" {
  description = "State bucket name; null derives <name_prefix>-tfstate-<account id> so no account id is typed."
  type        = string
  default     = null

  validation {
    condition     = var.state_bucket_name == null || can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid S3 bucket name (lowercase, digits, hyphens, 3-63 chars)."
  }

  validation {
    condition     = var.state_bucket_name == null || !startswith(coalesce(var.state_bucket_name, "-"), "${var.name_prefix}-dev-")
    error_message = "state_bucket_name must not start with <name_prefix>-dev-: the apply role manages buckets with that prefix."
  }
}
