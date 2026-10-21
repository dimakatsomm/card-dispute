variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "sender_email" {
  description = "Address verified as the SES email identity and used as the notifier From address (SES_SENDER)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.sender_email))
    error_message = "sender_email must be a single email address."
  }
}

variable "kms_key_arn" {
  description = "ARN of the cd-data KMS key used for SSE-KMS on the ses-events queue."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "events_retention_seconds" {
  description = "Message retention of the ses-events queue (E-03 delivery checks read it soon after sending)."
  type        = number
  default     = 86400

  validation {
    condition     = var.events_retention_seconds >= 60 && var.events_retention_seconds <= 1209600
    error_message = "events_retention_seconds must be between 60 and 1209600 (SQS limits)."
  }
}
