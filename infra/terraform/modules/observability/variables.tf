variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "alert_email" {
  description = "Recipient of alarm and budget notifications."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "budget_usd" {
  description = "Monthly AWS cost budget in USD."
  type        = number

  validation {
    condition     = var.budget_usd > 0
    error_message = "budget_usd must be positive."
  }
}

variable "kms_key_arn" {
  description = "ARN of the cd-data KMS key that encrypts the alarm topic."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "dlq_names" {
  description = "DLQ key (notifications, evidence-intake, retention-scheduler) to SQS queue name."
  type        = map(string)

  validation {
    condition     = length(setsubtract(keys(var.dlq_names), ["notifications", "evidence-intake", "retention-scheduler"])) == 0
    error_message = "dlq_names keys must be notifications, evidence-intake or retention-scheduler."
  }
}

variable "lambda_function_names" {
  description = "Lambda key to function name for created functions; null values are skipped."
  type        = map(string)
  default     = {}

  validation {
    condition     = length(setsubtract(keys(var.lambda_function_names), ["evidence-intake", "dispute-notifier", "retention-sweeper"])) == 0
    error_message = "lambda_function_names keys must be evidence-intake, dispute-notifier or retention-sweeper."
  }
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix (CloudWatch LoadBalancer dimension)."
  type        = string
}

variable "target_group_arn_suffixes" {
  description = "Target group key to ARN suffix (CloudWatch TargetGroup dimension)."
  type        = map(string)
}

variable "aurora_cluster_identifier" {
  description = "Aurora cluster identifier (CloudWatch DBClusterIdentifier dimension)."
  type        = string
}

variable "aurora_max_acu" {
  description = "Aurora Serverless v2 max ACU; sustained capacity at this value alarms."
  type        = number

  validation {
    condition     = var.aurora_max_acu >= 1
    error_message = "aurora_max_acu must be at least 1."
  }
}
