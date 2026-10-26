variable "name_prefix" {
  description = "Prefix for every resource name (cd-<component>) and secret path (cd/dev/...). The bootstrap apply role is scoped to it."
  type        = string
  default     = "cd"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.name_prefix))
    error_message = "name_prefix must be 2-10 lowercase alphanumerics starting with a letter (it is used in S3 bucket names)."
  }
}

variable "github_repo" {
  description = "GitHub repository as owner/repo; pins OIDC trust subjects and the repo tag."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$", var.github_repo))
    error_message = "github_repo must be \"owner/repo\"."
  }

  validation {
    condition     = !startswith(var.github_repo, "PLACEHOLDER/")
    error_message = "github_repo is still the placeholder; set the real owner/repo in dev.tfvars before planning."
  }
}

variable "github_oidc_subject_prefix" {
  description = "OIDC sub prefix GitHub issues for this repo; null means classic repo:<github_repo>. Repos with immutable subjects use repo:<owner>@<id>/<repo>@<id>."
  type        = string
  default     = null

  validation {
    condition     = var.github_oidc_subject_prefix == null || can(regex("^repo:[A-Za-z0-9][A-Za-z0-9-]{0,38}(@[0-9]+)?/[A-Za-z0-9._-]{1,100}(@[0-9]+)?$", var.github_oidc_subject_prefix))
    error_message = "github_oidc_subject_prefix must be repo:<owner>[@<id>]/<repo>[@<id>] without wildcards."
  }
}

variable "edge_origin_mode" {
  description = "vpc_origin: CloudFront VPC origin to an internal ALB. public_alb: CloudFront-only public ALB with a secret origin header (mock data only, ADR-063)."
  type        = string
  default     = "vpc_origin"

  validation {
    condition     = contains(["vpc_origin", "public_alb"], var.edge_origin_mode)
    error_message = "edge_origin_mode must be vpc_origin or public_alb."
  }
}

variable "lambda_image_uris" {
  description = "Lambda image URIs by function key; a function exists only when its key is present (runbook phase B)."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for k in keys(var.lambda_image_uris) : contains(["evidence-intake", "dispute-notifier", "retention-sweeper"], k)])
    error_message = "lambda_image_uris keys must be evidence-intake, dispute-notifier or retention-sweeper."
  }

  validation {
    condition = alltrue([
      for uri in values(var.lambda_image_uris) :
      can(regex("^[0-9]{12}\\.dkr\\.ecr\\.eu-north-1\\.amazonaws\\.com/[a-z0-9._/-]+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$", uri))
    ])
    error_message = "lambda_image_uris values must be eu-north-1 ECR image URIs with a tag or sha256 digest."
  }
}

variable "enable_service_autoscaling" {
  description = "Register ECS autoscaling targets (min 1, max 2). Keep false until the first deploy so services stay at desired_count 0."
  type        = bool
  default     = false
}

variable "enable_e2e_client" {
  description = "Create the e2e Cognito app client (ADMIN_USER_PASSWORD_AUTH only, ADR-062)."
  type        = bool
  default     = false
}

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid IPv4 CIDR of /20 or larger."
  }
}

variable "aurora_min_acu" {
  description = "Aurora Serverless v2 minimum capacity (ACU)."
  type        = number

  validation {
    condition     = var.aurora_min_acu >= 0 && var.aurora_min_acu <= 256 && floor(var.aurora_min_acu * 2) == var.aurora_min_acu * 2
    error_message = "aurora_min_acu must be 0-256 in steps of 0.5."
  }
}

variable "aurora_max_acu" {
  description = "Aurora Serverless v2 maximum capacity (ACU)."
  type        = number

  validation {
    condition     = var.aurora_max_acu >= 1 && var.aurora_max_acu <= 256 && floor(var.aurora_max_acu * 2) == var.aurora_max_acu * 2
    error_message = "aurora_max_acu must be 1-256 in steps of 0.5."
  }

  validation {
    condition     = var.aurora_max_acu >= var.aurora_min_acu
    error_message = "aurora_max_acu must be >= aurora_min_acu."
  }
}

variable "deletion_protection" {
  description = "Deletion protection on the Aurora cluster."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch log retention for services, Lambdas and tools."
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be one of 1, 3, 5, 7, 14, 30."
  }
}

variable "budget_usd" {
  description = "Monthly AWS budget in USD (alerts: forecast 100%, actual 80% and 100%)."
  type        = number

  validation {
    condition     = var.budget_usd > 0 && var.budget_usd <= 1000
    error_message = "budget_usd must be between 0 and 1000."
  }
}

variable "alert_email" {
  description = "Recipient of budget and alarm notifications."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "ses_sender" {
  description = "SES email identity used as the notifier From address (sandbox, ADR-046)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$", var.ses_sender))
    error_message = "ses_sender must be an email address."
  }
}
