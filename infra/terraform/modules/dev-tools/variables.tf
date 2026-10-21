variable "name_prefix" {
  description = "Prefix for families (cd-<tool>), role names (cd-<tool>-task, cd-<tool>-exec) and log groups (/cd/dev/tools/<tool>)."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary (cd-workload-boundary) attached to every task and execution role."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/", var.permissions_boundary_arn))
    error_message = "permissions_boundary_arn must be an IAM policy ARN."
  }
}

variable "iam_path" {
  description = "Path for the task and execution roles, e.g. /cd/."
  type        = string

  validation {
    condition     = can(regex("^/([A-Za-z0-9_+=,.@-]+/)*$", var.iam_path))
    error_message = "iam_path must start and end with /."
  }
}

variable "log_retention_days" {
  description = "Retention of the tool log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be one of 1, 3, 5, 7, 14, 30."
  }
}

variable "logs_kms_key_arn" {
  description = "KMS key (cd-data) that encrypts the tool log groups."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.logs_kms_key_arn))
    error_message = "logs_kms_key_arn must be a KMS key ARN."
  }
}

variable "cluster_arn" {
  description = "ECS cluster the tools are run on with RunTask (ecs-cluster.cluster_arn); passed through in run_task_network."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/[A-Za-z0-9_-]+$", var.cluster_arn))
    error_message = "cluster_arn must be an ECS cluster ARN."
  }
}

variable "image_uri" {
  description = "dev-tools image URI (ecr.repository_urls[\"dev-tools\"]); a placeholder tag such as :initial until the first publish, then the pipeline registers revisions with the git SHA."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9-]+-dev-tools[:@].+$", var.image_uri))
    error_message = "image_uri must be the <prefix>-dev-tools ECR repository with a tag or digest."
  }
}

variable "subnet_ids" {
  description = "Private subnets for RunTask (network.private_subnet_ids); passed through in run_task_network."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) > 0
    error_message = "subnet_ids must not be empty."
  }
}

variable "security_group_id" {
  description = "dev-tools security group (security.security_group_ids[\"dev-tools\"]); passed through in run_task_network."
  type        = string
}

variable "data_kms_key_arn" {
  description = "KMS key (cd-data) that encrypts the DB, Cognito and seed-user secrets."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.data_kms_key_arn))
    error_message = "data_kms_key_arn must be a KMS key ARN."
  }
}

variable "aurora" {
  description = "Aurora outputs: writer endpoint, port, database name, RDS-managed master secret ARN ({username,password}) and the nine role secret ARNs keyed by DB role."
  type = object({
    endpoint          = string
    port              = number
    database_name     = string
    master_secret_arn = string
    role_secret_arns  = map(string)
  })

  validation {
    condition = toset(keys(var.aurora.role_secret_arns)) == toset([
      "auth_migrator", "auth_app", "users_migrator", "users_app", "transactions_migrator",
      "transactions_app", "disputes_migrator", "disputes_app", "disputes_retention",
    ])
    error_message = "aurora.role_secret_arns must have exactly the nine DB role keys of backend/packages/db/bootstrap ROLES."
  }

  validation {
    condition = alltrue([
      for arn in concat([var.aurora.master_secret_arn], values(var.aurora.role_secret_arns)) :
      can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:", arn))
    ])
    error_message = "aurora secret ARNs must be Secrets Manager secret ARNs."
  }
}

variable "cognito_user_pool_arn" {
  description = "User pool ARN; the only resource for the seed's admin actions and the probe's AdminInitiateAuth."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:cognito-idp:[a-z0-9-]+:[0-9]{12}:userpool/[a-z0-9-]+_[A-Za-z0-9]+$", var.cognito_user_pool_arn))
    error_message = "cognito_user_pool_arn must be a single Cognito user pool ARN."
  }
}

variable "cognito_user_pool_id" {
  description = "User pool id, passed to dev-seed and net-probe as COGNITO_USER_POOL_ID."
  type        = string
}

variable "seed_user_secret_name_prefix" {
  description = "Name prefix of the seed-user password secrets dev-seed creates at run time, e.g. cd/dev/seed-users/."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+/dev/seed-users/$", var.seed_user_secret_name_prefix))
    error_message = "seed_user_secret_name_prefix must look like <prefix>/dev/seed-users/."
  }
}

variable "probe_environment" {
  description = "Plain net-probe env from I-WIRE: SERVICE_PORT_BASE_URL (alb :8081 base), TOKEN_URL, E2E_CLIENT_ID, SERVICE_CLIENT_ID (svc-notifier). Merged over the module defaults."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for k in keys(var.probe_environment) : !can(regex("(SECRET|PASSWORD|TOKEN$)", k))
    ])
    error_message = "Secret-looking variables must come from probe_secrets, not probe_environment."
  }
}

variable "probe_secrets" {
  description = "net-probe secrets (env name -> secret ARN, optional JSON key); I-WIRE passes SERVICE_CLIENT_SECRET = cognito.service_client_secret_arns[\"svc-notifier\"]."
  type = map(object({
    secret_arn = string
    json_key   = optional(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for s in values(var.probe_secrets) : can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:", s.secret_arn))
    ])
    error_message = "probe_secrets ARNs must be Secrets Manager secret ARNs."
  }
}

variable "probe_seed_username" {
  description = "Seed user whose password secret the probe reads to get a user token through the e2e client (persona A)."
  type        = string
  default     = "thandi.nkosi"

  validation {
    condition     = can(regex("^[a-z0-9._-]+$", var.probe_seed_username))
    error_message = "probe_seed_username must be a plain username without wildcards."
  }
}
