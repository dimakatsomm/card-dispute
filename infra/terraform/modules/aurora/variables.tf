variable "name_prefix" {
  description = "Prefix for resource names (cd-aurora) and secret paths (cd/dev/db/<role>)."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet ids for the DB subnet group (network.private_subnet_ids)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids needs at least two private subnets in different AZs."
  }
}

variable "security_group_id" {
  description = "The aurora security group from the security module."
  type        = string
}

variable "kms_key_arn" {
  description = "cd-data KMS key ARN: storage, master secret, role secrets and Performance Insights."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "min_acu" {
  description = "Serverless v2 minimum capacity (ACU)."
  type        = number

  validation {
    condition     = var.min_acu >= 0 && var.min_acu <= 256 && floor(var.min_acu * 2) == var.min_acu * 2
    error_message = "min_acu must be 0-256 in steps of 0.5."
  }
}

variable "max_acu" {
  description = "Serverless v2 maximum capacity (ACU)."
  type        = number

  validation {
    condition     = var.max_acu >= 1 && var.max_acu <= 256 && floor(var.max_acu * 2) == var.max_acu * 2 && var.max_acu >= var.min_acu
    error_message = "max_acu must be 1-256 in steps of 0.5 and >= min_acu."
  }
}

variable "deletion_protection" {
  description = "Deletion protection on the cluster."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy; false keeps a cd-aurora-final snapshot."
  type        = bool
  default     = false
}

variable "database_name" {
  description = "Initial database name."
  type        = string
  default     = "disputes"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a lowercase PostgreSQL identifier."
  }
}

variable "backup_retention_days" {
  description = "Automated backup retention in days."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 1-35."
  }
}

variable "engine_version" {
  description = "Aurora PostgreSQL 18 engine version (availability in eu-north-1 is verified by V-M3)."
  type        = string
  default     = "18.3"

  validation {
    condition     = can(regex("^18\\.[0-9]+$", var.engine_version))
    error_message = "engine_version must be an Aurora PostgreSQL 18.x version."
  }
}

variable "log_retention_days" {
  description = "Retention of the exported postgresql log group."
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be one of 1, 3, 5, 7, 14, 30."
  }
}

variable "logs_kms_key_arn" {
  description = "KMS key ARN (cd-data) encrypting the exported postgresql log group."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/", var.logs_kms_key_arn))
    error_message = "logs_kms_key_arn must be a KMS key ARN."
  }
}
