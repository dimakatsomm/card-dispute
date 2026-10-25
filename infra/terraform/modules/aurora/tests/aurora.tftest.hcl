mock_provider "aws" {
  mock_resource "aws_rds_cluster" {
    defaults = {
      arn                 = "arn:aws:rds:eu-north-1:123456789012:cluster:cd-aurora"
      endpoint            = "cd-aurora.cluster-abc123.eu-north-1.rds.amazonaws.com"
      cluster_resource_id = "cluster-ABCDEFGHIJKLMNOP"
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:rds!cluster-abc-AbCdEf"
        kms_key_id    = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
        secret_status = "active"
      }]
    }
  }
}

mock_provider "random" {}

variables {
  name_prefix         = "cd"
  subnet_ids          = ["subnet-private-a", "subnet-private-b"]
  security_group_id   = "sg-aurora"
  kms_key_arn         = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  min_acu             = 0.5
  max_acu             = 2
  deletion_protection = true
  logs_kms_key_arn    = "arn:aws:kms:eu-north-1:123456789012:key/11111111-1111-1111-1111-111111111111"
}

run "cluster_is_private_encrypted_and_tls_only" {
  command = apply

  assert {
    condition = (
      aws_cloudwatch_log_group.postgresql.name == "/aws/rds/cluster/${aws_rds_cluster.this.cluster_identifier}/postgresql" &&
      aws_cloudwatch_log_group.postgresql.retention_in_days == 7 &&
      aws_cloudwatch_log_group.postgresql.kms_key_id == var.logs_kms_key_arn
    )
    error_message = "The postgresql export log group must be pre-created with retention and the logs KMS key."
  }

  assert {
    condition     = aws_rds_cluster.this.engine_version == "18.3"
    error_message = "engine_version must default to 18.3 (V-M3)."
  }

  assert {
    condition     = one([for p in aws_rds_cluster_parameter_group.this.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "rds.force_ssl must be 1."
  }

  assert {
    condition     = aws_rds_cluster.this.db_cluster_parameter_group_name == aws_rds_cluster_parameter_group.this.name
    error_message = "The cluster must use the force_ssl parameter group."
  }

  assert {
    condition     = aws_rds_cluster.this.storage_encrypted && aws_rds_cluster.this.kms_key_id == var.kms_key_arn
    error_message = "Storage must be encrypted with cd-data."
  }

  assert {
    condition     = aws_rds_cluster_instance.writer.publicly_accessible == false
    error_message = "The writer must not be publicly accessible."
  }

  assert {
    condition     = aws_db_subnet_group.this.subnet_ids == toset(["subnet-private-a", "subnet-private-b"])
    error_message = "The subnet group must contain exactly the private subnets passed in."
  }

  assert {
    condition     = aws_rds_cluster.this.manage_master_user_password && aws_rds_cluster.this.master_user_secret_kms_key_id == var.kms_key_arn
    error_message = "The master password must be RDS-managed with cd-data."
  }

  assert {
    condition     = aws_rds_cluster.this.master_password == null
    error_message = "No master password may be set in configuration."
  }

  assert {
    condition     = aws_rds_cluster.this.iam_database_authentication_enabled == false
    error_message = "IAM DB auth is off by design."
  }

  assert {
    condition     = aws_rds_cluster.this.database_name == "disputes" && aws_rds_cluster.this.port == 5432
    error_message = "Database must be disputes on 5432."
  }

  assert {
    condition     = aws_rds_cluster_instance.writer.instance_class == "db.serverless"
    error_message = "The writer must be db.serverless."
  }

  assert {
    condition     = aws_rds_cluster.this.serverlessv2_scaling_configuration[0].min_capacity == 0.5 && aws_rds_cluster.this.serverlessv2_scaling_configuration[0].max_capacity == 2
    error_message = "Scaling must come from min_acu/max_acu."
  }

  assert {
    condition     = aws_rds_cluster.this.enabled_cloudwatch_logs_exports == toset(["postgresql"])
    error_message = "postgresql logs must be exported."
  }

  assert {
    condition     = aws_rds_cluster.this.backup_retention_period == 7 && aws_rds_cluster.this.deletion_protection
    error_message = "7-day backups and deletion protection from the variable."
  }
}

run "nine_role_secrets_match_bootstrap_roles" {
  command = apply

  assert {
    condition = toset(keys(aws_secretsmanager_secret.role)) == toset([
      "auth_migrator", "auth_app", "users_migrator", "users_app",
      "transactions_migrator", "transactions_app", "disputes_migrator", "disputes_app",
      "disputes_retention",
    ])
    error_message = "Role secrets must be exactly the bootstrap ROLES."
  }

  assert {
    condition     = alltrue([for k, s in aws_secretsmanager_secret.role : s.name == "cd/dev/db/${k}" && s.kms_key_id == var.kms_key_arn])
    error_message = "Secrets must be cd/dev/db/<role> encrypted with cd-data."
  }

  assert {
    condition     = alltrue([for p in random_password.role : p.special == false && p.length == 32])
    error_message = "Role passwords must be 32 chars with special = false."
  }

  assert {
    condition = alltrue([for k, v in aws_secretsmanager_secret_version.role :
      jsondecode(v.secret_string).url == "postgres://${k}:${random_password.role[k].result}@cd-aurora.cluster-abc123.eu-north-1.rds.amazonaws.com:5432/disputes?sslmode=verify-full"
    ])
    error_message = "Each url must be postgres://<role>:<pw>@<host>:5432/disputes?sslmode=verify-full."
  }

  assert {
    condition = alltrue([for k, v in aws_secretsmanager_secret_version.role :
      jsondecode(v.secret_string).username == k &&
      jsondecode(v.secret_string).password == random_password.role[k].result &&
      jsondecode(v.secret_string).host == aws_rds_cluster.this.endpoint &&
      jsondecode(v.secret_string).port == 5432 &&
      jsondecode(v.secret_string).dbname == "disputes"
    ])
    error_message = "Secret JSON must carry username, password, host, port and dbname."
  }

  assert {
    condition     = jsondecode(aws_secretsmanager_secret_version.role["disputes_retention"].secret_string).engine == "postgres"
    error_message = "The sweeper secret must be RDS format (engine)."
  }

  assert {
    condition     = length(output.role_secret_arns) == 9 && output.master_secret_arn == aws_rds_cluster.this.master_user_secret[0].secret_arn
    error_message = "Outputs must expose the nine role secret ARNs and the master secret ARN."
  }
}

run "final_snapshot_follows_variable" {
  command = plan

  variables {
    skip_final_snapshot = true
  }

  assert {
    condition     = aws_rds_cluster.this.skip_final_snapshot && aws_rds_cluster.this.final_snapshot_identifier == null
    error_message = "skip_final_snapshot must come from the variable."
  }
}
