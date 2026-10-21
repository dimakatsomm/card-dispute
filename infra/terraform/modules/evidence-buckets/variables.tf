variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary (cd-workload-boundary) attached to the GuardDuty malware protection role."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/", var.permissions_boundary_arn))
    error_message = "permissions_boundary_arn must be an IAM policy ARN."
  }
}

variable "iam_path" {
  description = "Path for the GuardDuty malware protection role, e.g. /cd/."
  type        = string

  validation {
    condition     = can(regex("^/([A-Za-z0-9_+=,.@-]+/)*$", var.iam_path))
    error_message = "iam_path must start and end with /."
  }
}

variable "kms_key_arn" {
  description = "ARN of the cd-evidence KMS key used for default SSE-KMS on both buckets."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "allowed_upload_origin" {
  description = "The only CORS origin allowed to PUT to the quarantine bucket: edge web_origin, https://<distribution domain>, no trailing slash."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?$", var.allowed_upload_origin))
    error_message = "allowed_upload_origin must be a single https origin with no path, trailing slash or wildcard."
  }
}

variable "enable_intake_target" {
  description = "Create the EventBridge target and Lambda permission for the intake alias; true only when the evidence-intake function exists."
  type        = bool
}

variable "intake_function_name" {
  description = "Name of the evidence-intake function (cd-evidence-intake); null while the function is not created."
  type        = string
  default     = null

  validation {
    condition     = !var.enable_intake_target || var.intake_function_name != null
    error_message = "intake_function_name is required when enable_intake_target is true."
  }
}

variable "intake_alias_arn" {
  description = "ARN of the evidence-intake alias live; null while the function is not created."
  type        = string
  default     = null

  validation {
    condition     = !var.enable_intake_target || can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+:live$", var.intake_alias_arn))
    error_message = "intake_alias_arn must be the evidence-intake function ARN qualified with :live when enable_intake_target is true."
  }
}

variable "intake_dlq_arn" {
  description = "ARN of cd-evidence-intake-dlq (messaging), the dead-letter queue of the scan-result rule target."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:sqs:", var.intake_dlq_arn))
    error_message = "intake_dlq_arn must be an SQS queue ARN."
  }
}

variable "quarantine_expiration_days" {
  description = "Days before a quarantine object (and an incomplete multipart upload) is removed."
  type        = number
  default     = 1

  validation {
    condition     = var.quarantine_expiration_days >= 1 && floor(var.quarantine_expiration_days) == var.quarantine_expiration_days
    error_message = "quarantine_expiration_days must be a whole number of at least 1."
  }
}

variable "evidence_expiration_days" {
  description = "Days before an object under evidence/ in the evidence bucket expires."
  type        = number
  default     = 365

  validation {
    condition     = var.evidence_expiration_days >= 1 && floor(var.evidence_expiration_days) == var.evidence_expiration_days
    error_message = "evidence_expiration_days must be a whole number of at least 1."
  }
}
