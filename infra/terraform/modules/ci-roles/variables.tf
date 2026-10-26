variable "name_prefix" {
  description = "Prefix for role names (<name_prefix>-gha-<kind>) and for names the roles are scoped to (functions, queues, log groups, tool families)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.name_prefix))
    error_message = "name_prefix must be 2-10 lowercase alphanumerics starting with a letter."
  }
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary (cd-workload-boundary) attached to every CI role."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/", var.permissions_boundary_arn))
    error_message = "permissions_boundary_arn must be an IAM policy ARN."
  }
}

variable "iam_path" {
  description = "Path for every CI role, e.g. /cd/."
  type        = string

  validation {
    condition     = can(regex("^/([A-Za-z0-9_+=,.@-]+/)*$", var.iam_path))
    error_message = "iam_path must start and end with /."
  }
}

variable "github_repo" {
  description = "GitHub repository as owner/repo; pins the exact OIDC sub of every role."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$", var.github_repo))
    error_message = "github_repo must be \"owner/repo\" without wildcards."
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

variable "github_oidc_provider_arn" {
  description = "IAM OIDC provider for token.actions.githubusercontent.com (bootstrap github_oidc_provider_arn)."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    error_message = "github_oidc_provider_arn must be the token.actions.githubusercontent.com OIDC provider ARN."
  }
}

variable "ecr_repository_arns" {
  description = "ECR repository ARN by repo key (ecr.repository_arns); all nine keys."
  type        = map(string)

  validation {
    condition = toset(keys(var.ecr_repository_arns)) == toset([
      "svc-auth", "svc-users", "svc-transactions", "svc-disputes", "web",
      "lambda-evidence-intake", "lambda-dispute-notifier", "lambda-retention-sweeper",
      "dev-tools",
    ])
    error_message = "ecr_repository_arns must have exactly the nine ECR repo keys in modules/README.md section 2."
  }

  validation {
    condition     = alltrue([for a in values(var.ecr_repository_arns) : can(regex("^arn:aws[a-z-]*:ecr:[a-z0-9-]+:[0-9]{12}:repository/[a-z0-9._/-]+$", a))])
    error_message = "ecr_repository_arns values must be ECR repository ARNs."
  }
}

variable "ecs_cluster_arn" {
  description = "ECS cluster ARN (ecs-cluster.cluster_arn); every ECS action is conditioned on it."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/[A-Za-z0-9_-]+$", var.ecs_cluster_arn))
    error_message = "ecs_cluster_arn must be an ECS cluster ARN."
  }
}

variable "ecs_deployables" {
  description = "Per ECS service key: service ARN, its task-definition families (service + migrate) and its task + execution role ARNs for PassRole."
  type = map(object({
    service_arn              = string
    task_definition_families = list(string)
    pass_role_arns           = list(string)
  }))

  validation {
    condition     = toset(keys(var.ecs_deployables)) == toset(["auth", "users", "transactions", "disputes", "web"])
    error_message = "ecs_deployables must have exactly the keys auth, users, transactions, disputes, web."
  }

  validation {
    condition = alltrue([
      for d in values(var.ecs_deployables) :
      length(d.task_definition_families) > 0 && length(d.pass_role_arns) > 0
      && alltrue([for f in d.task_definition_families : can(regex("^[A-Za-z0-9_-]+$", f))])
    ])
    error_message = "Each ecs_deployables entry needs at least one plain family name (no wildcards) and at least one pass role ARN."
  }
}

variable "lambda_function_names" {
  description = "Function name by Lambda key, built from naming (cd-<key>) so the roles exist before the functions (ADR-066)."
  type        = map(string)

  validation {
    condition     = toset(keys(var.lambda_function_names)) == toset(["evidence-intake", "dispute-notifier", "retention-sweeper"])
    error_message = "lambda_function_names must have exactly the keys evidence-intake, dispute-notifier, retention-sweeper."
  }

  validation {
    condition     = alltrue([for n in values(var.lambda_function_names) : can(regex("^[A-Za-z0-9_-]{1,64}$", n))])
    error_message = "lambda_function_names values must be plain function names (no ARNs, no wildcards)."
  }
}

variable "dev_tools" {
  description = "dev-tools task-definition families (db-bootstrap, dev-seed, net-probe) and their task + execution role ARNs."
  type = object({
    task_definition_families = list(string)
    pass_role_arns           = list(string)
  })

  validation {
    condition     = length(var.dev_tools.task_definition_families) > 0 && alltrue([for f in var.dev_tools.task_definition_families : can(regex("^[A-Za-z0-9_-]+$", f))])
    error_message = "dev_tools.task_definition_families must be plain family names (no wildcards)."
  }
}

variable "cognito_user_pool_arn" {
  description = "User pool ARN; e2e may call AdminInitiateAuth on it only."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:cognito-idp:[a-z0-9-]+:[0-9]{12}:userpool/[A-Za-z0-9_-]+$", var.cognito_user_pool_arn))
    error_message = "cognito_user_pool_arn must be a Cognito user pool ARN."
  }
}

variable "seed_user_secret_name_prefix" {
  description = "Secret name prefix of the seed users written by dev-seed (cd/dev/seed-users/)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9/_+=.@-]+/$", var.seed_user_secret_name_prefix))
    error_message = "seed_user_secret_name_prefix must end with / and contain no wildcards."
  }
}

variable "ses_events_queue_arn" {
  description = "cd-ses-events queue ARN (ses.ses_events_queue_arn); e2e receives and deletes on it."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:sqs:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$", var.ses_events_queue_arn))
    error_message = "ses_events_queue_arn must be an SQS queue ARN."
  }
}

variable "evidence_bucket_arns" {
  description = "Quarantine and evidence bucket ARNs; e2e lists them and heads objects."
  type        = list(string)

  validation {
    condition     = length(var.evidence_bucket_arns) > 0 && alltrue([for a in var.evidence_bucket_arns : can(regex("^arn:aws[a-z-]*:s3:::[a-z0-9.-]{3,63}$", a))])
    error_message = "evidence_bucket_arns must be S3 bucket ARNs."
  }
}

variable "data_kms_key_arn" {
  description = "cd-data key; e2e decrypts with it only via SQS and Secrets Manager."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.data_kms_key_arn))
    error_message = "data_kms_key_arn must be a KMS key ARN."
  }
}
