variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the cd-data KMS key used for SSE-KMS on every queue."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "notifier_timeout_seconds" {
  description = "dispute-notifier Lambda timeout; the notifications queue visibility timeout is 6x this value."
  type        = number
  default     = 30

  validation {
    condition     = var.notifier_timeout_seconds >= 1 && var.notifier_timeout_seconds <= 900 && floor(var.notifier_timeout_seconds) == var.notifier_timeout_seconds
    error_message = "notifier_timeout_seconds must be a whole number between 1 and 900 (the Lambda maximum)."
  }
}

variable "max_receive_count" {
  description = "Receives before a notification message moves to its DLQ."
  type        = number
  default     = 5

  validation {
    condition     = var.max_receive_count >= 1 && var.max_receive_count <= 1000 && floor(var.max_receive_count) == var.max_receive_count
    error_message = "max_receive_count must be a whole number between 1 and 1000."
  }
}

variable "allowed_sender_role_arns" {
  description = "IAM role ARNs allowed to send to the notifications queue (the disputes task role). Every other principal is denied."
  type        = list(string)

  validation {
    condition     = length(var.allowed_sender_role_arns) > 0 && alltrue([for a in var.allowed_sender_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "allowed_sender_role_arns must hold at least one IAM role ARN; an empty list would deny every sender."
  }
}

variable "allowed_consumer_role_arns" {
  description = "IAM role ARNs allowed to receive and delete from the notifications queue (the notifier role). Every other principal is denied."
  type        = list(string)

  validation {
    condition     = length(var.allowed_consumer_role_arns) > 0 && alltrue([for a in var.allowed_consumer_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "allowed_consumer_role_arns must hold at least one IAM role ARN; an empty list would deny every consumer."
  }
}

variable "redrive_operator_arns" {
  description = "IAM role ARNs or ArnLike patterns (e.g. the SSO admin role) allowed to redrive the notifications DLQ back to the queue."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.redrive_operator_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "redrive_operator_arns entries must be IAM role ARNs or role ARN patterns in this account format."
  }
}

variable "evidence_scan_rule_arn" {
  description = "ARN of the GuardDuty scan-result EventBridge rule whose target DLQ is the evidence-intake DLQ."
  type        = string
}

variable "evidence_intake_role_arns" {
  description = "evidence-intake Lambda role ARNs that send async on-failure records to the evidence-intake DLQ (the role exists in phase A)."
  type        = list(string)

  validation {
    condition     = length(var.evidence_intake_role_arns) > 0 && alltrue([for a in var.evidence_intake_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "evidence_intake_role_arns must hold at least one IAM role ARN; an empty list would deny intake on-failure records."
  }
}

variable "retention_scheduler_role_arns" {
  description = "EventBridge Scheduler execution role ARNs of the retention-sweeper schedule (Scheduler sends to its DLQ as this role)."
  type        = list(string)

  validation {
    condition     = length(var.retention_scheduler_role_arns) > 0 && alltrue([for a in var.retention_scheduler_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", a))])
    error_message = "retention_scheduler_role_arns must hold at least one IAM role ARN; an empty list would make the DLQ deny unconditional."
  }
}
