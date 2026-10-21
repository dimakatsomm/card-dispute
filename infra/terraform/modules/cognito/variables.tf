variable "name_prefix" {
  description = "Prefix for resource names (cd-<component>) and secret paths (cd/dev/...)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.name_prefix))
    error_message = "name_prefix must be 2-10 lowercase alphanumerics starting with a letter."
  }
}

variable "callback_urls" {
  description = "SPA OAuth redirect URIs: <web_origin>/callback."
  type        = list(string)

  validation {
    condition     = length(var.callback_urls) > 0 && alltrue([for u in var.callback_urls : can(regex("^https://[^/?#]+/callback$", u))])
    error_message = "callback_urls must be non-empty https URLs ending in /callback."
  }
}

variable "logout_urls" {
  description = "SPA post-logout URIs: <web_origin>/."
  type        = list(string)

  validation {
    condition     = length(var.logout_urls) > 0 && alltrue([for u in var.logout_urls : can(regex("^https://[^/?#]+/$", u))])
    error_message = "logout_urls must be non-empty https origins with a trailing slash."
  }
}

variable "enable_e2e_client" {
  description = "Create the e2e app client (ALLOW_ADMIN_USER_PASSWORD_AUTH only, ADR-062)."
  type        = bool
}

variable "secrets_kms_key_arn" {
  description = "KMS key (cd-data) encrypting the client-secret secrets."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/.+$", var.secrets_kms_key_arn))
    error_message = "secrets_kms_key_arn must be a KMS key ARN."
  }
}

variable "deletion_protection" {
  description = "Deletion protection on the user pool."
  type        = bool
  default     = true
}

variable "domain_suffix" {
  description = "Suffix making the hosted UI prefix domain <name_prefix>-dev-<suffix> globally unique; null generates one."
  type        = string
  default     = null

  validation {
    condition     = var.domain_suffix == null || can(regex("^[a-z0-9]{1,20}$", coalesce(var.domain_suffix, "x"))) && !can(regex("aws|amazon|cognito", coalesce(var.domain_suffix, "x")))
    error_message = "domain_suffix must be 1-20 lowercase alphanumerics and must not contain aws, amazon or cognito."
  }
}
