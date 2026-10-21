variable "name_prefix" {
  description = "Prefix for the function (cd-<key>), roles (cd-<key>-role, cd-<key>-scheduler) and log group (/aws/lambda/cd-<key>)."
  type        = string
}

variable "function_key" {
  description = "Lambda key: evidence-intake, dispute-notifier or retention-sweeper."
  type        = string

  validation {
    condition     = contains(["evidence-intake", "dispute-notifier", "retention-sweeper"], var.function_key)
    error_message = "function_key must be evidence-intake, dispute-notifier or retention-sweeper."
  }
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary (cd-workload-boundary) attached to the function and scheduler roles."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/", var.permissions_boundary_arn))
    error_message = "permissions_boundary_arn must be an IAM policy ARN."
  }
}

variable "iam_path" {
  description = "Path for the roles, e.g. /cd/."
  type        = string

  validation {
    condition     = can(regex("^/([A-Za-z0-9_+=,.@-]+/)*$", var.iam_path))
    error_message = "iam_path must start and end with /."
  }
}

variable "log_retention_days" {
  description = "Retention of the function log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be one of 1, 3, 5, 7, 14, 30."
  }
}

variable "logs_kms_key_arn" {
  description = "KMS key (cd-data) that encrypts the log group."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.logs_kms_key_arn))
    error_message = "logs_kms_key_arn must be a KMS key ARN."
  }
}

variable "image_uri" {
  description = "ECR image URI (tag or digest). null creates no function (role, log group and scheduler role still exist). Ignored after create; the pipeline owns the code."
  type        = string
  default     = null

  validation {
    condition     = var.image_uri == null || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.af-south-1\\.amazonaws\\.com/[a-z0-9._/-]+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$", var.image_uri))
    error_message = "image_uri must be null or an af-south-1 ECR image URI with a tag or sha256 digest."
  }
}

variable "memory_mb" {
  description = "Function memory in MB."
  type        = number
  default     = 256

  validation {
    condition     = var.memory_mb >= 128 && var.memory_mb <= 10240
    error_message = "memory_mb must be 128-10240."
  }
}

variable "timeout_seconds" {
  description = "Function timeout (intake 60, notifier 30, sweeper 300). messaging sets the notifications visibility to 6x the notifier timeout."
  type        = number

  validation {
    condition     = var.timeout_seconds >= 1 && var.timeout_seconds <= 900
    error_message = "timeout_seconds must be 1-900."
  }
}

variable "subnet_ids" {
  description = "Private subnet ids (network.private_subnet_ids)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 1
    error_message = "subnet_ids needs at least one private subnet."
  }
}

variable "security_group_id" {
  description = "The function's own security group (security.security_group_ids[<key>])."
  type        = string
}

variable "environment" {
  description = "Plain environment variables, merged over the module defaults. Secrets are passed as *_SECRET_ID / *_SECRET_ARN references, never values."
  type        = map(string)
  default     = {}

  validation {
    condition     = lookup(var.environment, "EVIDENCE_REQUIRE_SCAN", "true") == "true"
    error_message = "EVIDENCE_REQUIRE_SCAN must be \"true\" in AWS; the V-03 fallback needs an owner decision, not a variable."
  }

  validation {
    condition     = alltrue([for k in keys(var.environment) : !endswith(k, "_SECRET")])
    error_message = "Raw *_SECRET variables are local only; pass a Secrets Manager reference as *_SECRET_ID or *_SECRET_ARN."
  }

  validation {
    condition = length(setintersection(keys(var.environment), [
      "DATABASE_URL", "AWS_ENDPOINT_URL", "SES_ENDPOINT",
    ])) == 0
    error_message = "DATABASE_URL, AWS_ENDPOINT_URL and SES_ENDPOINT are local only (use DATABASE_SECRET_ID; AWS uses real endpoints)."
  }

  validation {
    condition     = lookup(var.environment, "DB_SSL", "true") == "true"
    error_message = "DB_SSL must be \"true\" in AWS (rds.force_ssl=1)."
  }

  validation {
    condition = alltrue([for k in keys(var.environment) :
      !startswith(k, "AWS_LAMBDA_") && !startswith(k, "_") && !contains([
        "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_EXECUTION_ENV", "AWS_ACCESS_KEY", "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR",
      ], k)
    ])
    error_message = "Lambda reserves AWS_REGION, AWS_LAMBDA_*, credential and runtime variables; they cannot be set."
  }
}

variable "policy_statements" {
  description = "Per-function role statements (least privilege per docs/05, defined by I-WIRE). Added to the module's logs/ENI/DLQ statements."
  type = list(object({
    Sid       = string
    Effect    = string
    Action    = list(string)
    Resource  = list(string)
    Condition = optional(map(map(list(string))))
  }))
  default = []

  validation {
    condition     = alltrue([for s in var.policy_statements : contains(["Allow", "Deny"], s.Effect) && can(regex("^[A-Za-z0-9]+$", s.Sid))])
    error_message = "Each statement needs Effect Allow or Deny and an alphanumeric Sid."
  }

  validation {
    condition = alltrue([for s in var.policy_statements :
      length(s.Action) > 0 && length(s.Resource) > 0 &&
      alltrue([for a in s.Action : a != "*" && !endswith(a, ":*")]) &&
      alltrue([for r in s.Resource : r != "*"])
    ])
    error_message = "Role statements list explicit actions and resources: no \"*\" or service:* (modules/README.md IAM rules)."
  }

  validation {
    condition     = length(setintersection([for s in var.policy_statements : s.Sid], ["WriteOwnLogGroup", "VpcEniManagement", "VpcEniDescribe", "SendAsyncFailures", "EncryptAsyncFailures"])) == 0
    error_message = "That Sid is reserved for a module statement."
  }

  validation {
    condition = var.sqs_event_source == null || length(setsubtract(
      ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      flatten([for s in var.policy_statements : s.Action if s.Effect == "Allow"]),
    )) == 0
    error_message = "With sqs_event_source, policy_statements must allow sqs:ReceiveMessage, sqs:DeleteMessage and sqs:GetQueueAttributes on the queue."
  }
}

variable "data_kms_key_arn" {
  description = "cd-data KMS key ARN: encrypts the SQS DLQs this module sends to (the environment uses the AWS-managed key)."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.data_kms_key_arn))
    error_message = "data_kms_key_arn must be a KMS key ARN."
  }
}

variable "sqs_event_source" {
  description = "SQS queue polled by the function (notifier); null for none. Mapped to the live alias with ReportBatchItemFailures."
  type = object({
    queue_arn  = string
    batch_size = optional(number, 10)
  })
  default = null

  validation {
    condition     = var.sqs_event_source == null || try(var.sqs_event_source.batch_size >= 1 && var.sqs_event_source.batch_size <= 10, false)
    error_message = "sqs_event_source.batch_size must be 1-10 (no batching window)."
  }
}

variable "schedule" {
  description = "EventBridge Scheduler schedule invoking the live alias (sweeper); null for none. dlq_arn receives events Scheduler fails to deliver."
  type = object({
    expression = string
    timezone   = string
    dlq_arn    = string
  })
  default = null

  validation {
    condition     = var.schedule == null || can(regex("^(cron|rate)\\(.+\\)$", var.schedule.expression))
    error_message = "schedule.expression must be cron(...) or rate(...)."
  }

  validation {
    condition     = var.schedule == null || length(try(var.schedule.timezone, "")) > 0
    error_message = "schedule.timezone must be an IANA zone, e.g. Africa/Johannesburg."
  }
}

variable "schedule_max_retries" {
  description = "Scheduler retry attempts before the schedule DLQ."
  type        = number
  default     = 2

  validation {
    condition     = var.schedule_max_retries >= 0 && var.schedule_max_retries <= 185
    error_message = "schedule_max_retries must be 0-185."
  }
}

variable "async_on_failure_arn" {
  description = "SQS queue ARN for failed asynchronous invocations of the live alias (intake: cd-evidence-intake-dlq); null for none."
  type        = string
  default     = null
}

variable "async_max_retries" {
  description = "Retries for asynchronous invocations of the live alias (EventBridge, Scheduler)."
  type        = number
  default     = 2

  validation {
    condition     = var.async_max_retries >= 0 && var.async_max_retries <= 2
    error_message = "async_max_retries must be 0-2."
  }
}
