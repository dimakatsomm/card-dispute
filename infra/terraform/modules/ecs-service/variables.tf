variable "name_prefix" {
  description = "Prefix for resource names (cd-<svc>, cd-<svc>-task, cd-<svc>-exec) and the log group path (/cd/dev/ecs/<svc>)."
  type        = string
}

variable "service_name" {
  description = "Service key; also the container name, the Service Connect alias and the discovery name."
  type        = string

  validation {
    condition     = contains(["auth", "users", "transactions", "disputes", "web"], var.service_name)
    error_message = "service_name must be auth, users, transactions, disputes or web."
  }
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary (cd-workload-boundary) attached to the task and execution roles."
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
  description = "Retention of the service log group."
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

variable "cluster_arn" {
  description = "ECS cluster ARN (ecs-cluster.cluster_arn)."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/[A-Za-z0-9_-]+$", var.cluster_arn))
    error_message = "cluster_arn must be an ECS cluster ARN."
  }
}

variable "namespace_arn" {
  description = "Cloud Map namespace ARN for Service Connect (cd.internal)."
  type        = string
}

variable "namespace_id" {
  description = "Cloud Map namespace id; used only when register_cloud_map_service is true."
  type        = string
}

variable "image_uri" {
  description = "ECR image URI. A placeholder tag (e.g. :initial) until the first deploy; the pipeline registers new revisions."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.eu-north-1\\.amazonaws\\.com/[a-z0-9._/-]+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$", var.image_uri))
    error_message = "image_uri must be an eu-north-1 ECR image URI with a tag or sha256 digest."
  }
}

variable "subnet_ids" {
  description = "Private subnet ids for the tasks (network.private_subnet_ids)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 1
    error_message = "subnet_ids needs at least one private subnet."
  }
}

variable "security_group_id" {
  description = "The service's own security group (security.security_group_ids[<svc>])."
  type        = string
}

variable "cpu" {
  description = "Task CPU units (ADR-065: per-service, default 0.25 vCPU)."
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.cpu)
    error_message = "cpu must be a Fargate size: 256, 512, 1024, 2048 or 4096."
  }
}

variable "memory" {
  description = "Task memory in MiB (ADR-065: per-service, default 0.5 GB)."
  type        = number
  default     = 512

  validation {
    condition     = var.memory >= 512 && var.memory <= 30720 && var.memory % 512 == 0
    error_message = "memory must be 512-30720 MiB in steps of 512 (and valid for the chosen cpu)."
  }
}

variable "service_connect_server" {
  description = "Publish port 8081 as Service Connect alias <svc>:8081 (backend services). Server mode includes client mode. false disables Service Connect (web)."
  type        = bool

  validation {
    condition     = !var.service_connect_server || var.service_name != "web"
    error_message = "web has no service port, so it cannot be a Service Connect server."
  }
}

variable "register_cloud_map_service" {
  description = "Also register task IPs as DNS <svc>.cd.internal (public_alb fallback, users and disputes only, ADR-059)."
  type        = bool
  default     = false

  validation {
    condition     = !var.register_cloud_map_service || contains(["users", "disputes"], var.service_name)
    error_message = "Only users and disputes register a Cloud Map DNS service."
  }
}

variable "target_groups" {
  description = "ALB target groups to attach, keyed by container port: \"8080\" (public) and \"8081\" (users and disputes only)."
  type = map(object({
    arn            = string
    container_port = number
  }))
  default = {}

  validation {
    condition     = alltrue([for k, tg in var.target_groups : contains(["8080", "8081"], k) && tostring(tg.container_port) == k])
    error_message = "target_groups keys must be \"8080\" or \"8081\" and equal their container_port."
  }

  validation {
    condition     = !contains(keys(var.target_groups), "8081") || contains(["users", "disputes"], var.service_name)
    error_message = "Only users and disputes attach a :8081 target group (ADR-059)."
  }
}

variable "health_check_path" {
  description = "Container liveness path on port 8080: /health for backend services, /healthz for web. Not /ready: it checks the DB, and a DB blip would make ECS kill healthy tasks (ALB target groups use /ready)."
  type        = string

  validation {
    condition     = var.health_check_path == (var.service_name == "web" ? "/healthz" : "/health")
    error_message = "health_check_path must be /health for backend services and /healthz for web (never /ready)."
  }
}

variable "environment" {
  description = "Plain environment variables; merged over the module defaults (see README). Never secrets."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.environment), "AUTH_ALLOW_INSECURE_JWKS")
    error_message = "AUTH_ALLOW_INSECURE_JWKS is local-compose only and must never be set in AWS."
  }

  validation {
    condition = length(setintersection(keys(var.environment), [
      "DATABASE_URL", "MIGRATOR_DATABASE_URL", "SERVICE_CLIENT_SECRET",
    ])) == 0
    error_message = "DATABASE_URL, MIGRATOR_DATABASE_URL and SERVICE_CLIENT_SECRET must come from secrets, not environment."
  }

  validation {
    condition = var.service_name != "web" || length(setsubtract([
      "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_REDIRECT_URI", "OIDC_LOGOUT_URL", "OIDC_POST_LOGOUT_URI",
      "UPLOAD_ORIGIN", "OIDC_TOKEN_ORIGIN",
    ], keys(var.environment))) == 0
    error_message = "web needs OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_LOGOUT_URL, OIDC_POST_LOGOUT_URI, UPLOAD_ORIGIN and OIDC_TOKEN_ORIGIN."
  }
}

variable "secrets" {
  description = "Env var name -> Secrets Manager secret (ARN + optional JSON key). The execution role can read only these (and the migrate secrets)."
  type = map(object({
    secret_arn = string
    json_key   = optional(string)
  }))
  default = {}

  validation {
    condition     = length(setintersection(keys(var.secrets), keys(var.environment))) == 0
    error_message = "A variable cannot be both in environment and secrets."
  }
}

variable "migrate" {
  description = "One-shot migration task definition <prefix>-<svc>-migrate (DB services only); null for none. Same image; command is the service migrate entry (images have no ENTRYPOINT, e.g. [\"node\",\"src/migrate.ts\"]) and MIGRATOR_DATABASE_URL from the migrator secret key url."
  type = object({
    command     = list(string)
    environment = map(string)
    secrets = map(object({
      secret_arn = string
      json_key   = optional(string)
    }))
  })
  default = null

  validation {
    condition     = var.migrate == null || var.service_name != "web"
    error_message = "web has no database and no migrate task."
  }

  validation {
    condition     = var.migrate == null || contains(keys(try(var.migrate.secrets, {})), "MIGRATOR_DATABASE_URL")
    error_message = "migrate.secrets must provide MIGRATOR_DATABASE_URL."
  }

  validation {
    condition     = var.migrate == null || !contains(keys(try(var.migrate.environment, {})), "MIGRATOR_DATABASE_URL")
    error_message = "MIGRATOR_DATABASE_URL must come from migrate.secrets, not migrate.environment."
  }
}

variable "task_role_statements" {
  description = "Per-service task role statements (least privilege per docs/05, defined by I-WIRE). Empty means the task role has no policy."
  type = list(object({
    Sid       = string
    Effect    = string
    Action    = list(string)
    Resource  = list(string)
    Condition = optional(map(map(list(string))))
  }))
  default = []

  validation {
    condition     = alltrue([for s in var.task_role_statements : contains(["Allow", "Deny"], s.Effect) && can(regex("^[A-Za-z0-9]+$", s.Sid))])
    error_message = "Each statement needs Effect Allow or Deny and an alphanumeric Sid."
  }

  validation {
    condition = alltrue([for s in var.task_role_statements :
      length(s.Action) > 0 && length(s.Resource) > 0 &&
      alltrue([for a in s.Action : a != "*" && !endswith(a, ":*")]) &&
      alltrue([for r in s.Resource : r != "*"])
    ])
    error_message = "Task role statements list explicit actions and resources: no \"*\" or service:* (modules/README.md IAM rules)."
  }
}

variable "data_kms_key_arn" {
  description = "cd-data KMS key ARN; the execution role may Decrypt it via Secrets Manager only."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.data_kms_key_arn))
    error_message = "data_kms_key_arn must be a KMS key ARN."
  }
}

variable "enable_autoscaling" {
  description = "Register the autoscaling target and CPU policy. Keep false until the first deploy: min capacity 1 would start tasks before an image exists."
  type        = bool
  default     = false
}

variable "autoscaling_min_capacity" {
  description = "Autoscaling minimum task count (used only when enable_autoscaling)."
  type        = number
  default     = 1

  validation {
    condition     = var.autoscaling_min_capacity >= 1
    error_message = "autoscaling_min_capacity must be >= 1."
  }
}

variable "autoscaling_max_capacity" {
  description = "Autoscaling maximum task count (used only when enable_autoscaling)."
  type        = number
  default     = 2

  validation {
    condition     = var.autoscaling_max_capacity >= var.autoscaling_min_capacity && var.autoscaling_max_capacity <= 10
    error_message = "autoscaling_max_capacity must be between autoscaling_min_capacity and 10."
  }
}

variable "autoscaling_cpu_target" {
  description = "Target average CPU utilisation (%) for the target-tracking policy."
  type        = number
  default     = 60

  validation {
    condition     = var.autoscaling_cpu_target >= 10 && var.autoscaling_cpu_target <= 90
    error_message = "autoscaling_cpu_target must be 10-90."
  }
}

variable "desired_count" {
  description = "Initial desired count. Terraform ignores later changes; the pipeline or autoscaling owns it."
  type        = number
  default     = 0

  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 10
    error_message = "desired_count must be 0-10."
  }
}
