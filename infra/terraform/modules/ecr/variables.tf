variable "name_prefix" {
  description = "Prefix for repository names (cd-<repo key>) and the Lambda function pattern allowed to pull (cd-*)."
  type        = string
}

variable "repository_keys" {
  description = "Repository keys; each becomes repository <name_prefix>-<key>. Keys starting with lambda- get the Lambda pull policy."
  type        = list(string)
  default = [
    "svc-auth", "svc-users", "svc-transactions", "svc-disputes", "web",
    "lambda-evidence-intake", "lambda-dispute-notifier", "lambda-retention-sweeper",
    "dev-tools",
  ]

  validation {
    condition = alltrue([for k in var.repository_keys : contains([
      "svc-auth", "svc-users", "svc-transactions", "svc-disputes", "web",
      "lambda-evidence-intake", "lambda-dispute-notifier", "lambda-retention-sweeper",
      "dev-tools",
    ], k)])
    error_message = "repository_keys must be drawn from the fixed ECR repo keys in modules/README.md section 2."
  }
}

variable "kms_key_arn" {
  description = "KMS key (cd-data) for repository encryption."
  type        = string
}

variable "keep_images" {
  description = "Number of most recent images kept per repository; older ones expire."
  type        = number
  default     = 10

  validation {
    condition     = var.keep_images >= 1 && floor(var.keep_images) == var.keep_images
    error_message = "keep_images must be a positive integer."
  }
}
