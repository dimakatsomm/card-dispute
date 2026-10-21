locals {
  identifier = "${var.name_prefix}-aurora"
  port       = 5432

  # Must equal ROLES in backend/packages/db/bootstrap/bootstrap.ts.
  roles = toset([
    "auth_migrator", "auth_app",
    "users_migrator", "users_app",
    "transactions_migrator", "transactions_app",
    "disputes_migrator", "disputes_app",
    "disputes_retention",
  ])
}

resource "aws_db_subnet_group" "this" {
  name       = local.identifier
  subnet_ids = var.subnet_ids
  tags       = { component = "aurora" }
}

resource "aws_rds_cluster_parameter_group" "this" {
  name   = "${local.identifier}-pg18"
  family = "aurora-postgresql18"
  tags   = { component = "aurora" }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

# Pre-created so RDS exports into a group with bounded retention and KMS instead of creating its own.
resource "aws_cloudwatch_log_group" "postgresql" {
  #checkov:skip=CKV_AWS_338:Dev keeps logs for log_retention_days (default 7), not a year.
  name              = "/aws/rds/cluster/${local.identifier}/postgresql"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
  tags              = { component = "aurora" }
}

resource "aws_rds_cluster" "this" {
  #checkov:skip=CKV_AWS_162:IAM DB auth off by design; services use per-role passwords from Secrets Manager (I-04).
  #checkov:skip=CKV2_AWS_8:7-day automated backups suffice for dev; no AWS Backup plan.
  #checkov:skip=CKV2_AWS_27:Statement logging would write customer data to logs; only server logs are exported.
  #checkov:skip=CKV_AWS_313:Single writer by design (docs/06 cost table); dev is not multi-AZ.
  cluster_identifier = local.identifier
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.engine_version
  database_name      = var.database_name
  port               = local.port

  master_username               = "cd_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [var.security_group_id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name

  storage_encrypted                   = true
  kms_key_id                          = var.kms_key_arn
  iam_database_authentication_enabled = false

  enabled_cloudwatch_logs_exports = ["postgresql"]

  backup_retention_period   = var.backup_retention_days
  preferred_backup_window   = "00:00-01:00"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${local.identifier}-final"

  serverlessv2_scaling_configuration {
    min_capacity = var.min_acu
    max_capacity = var.max_acu
  }

  tags = { component = "aurora" }

  depends_on = [aws_cloudwatch_log_group.postgresql]
}

resource "aws_rds_cluster_instance" "writer" {
  #checkov:skip=CKV_AWS_118:Enhanced monitoring needs an extra IAM role; CloudWatch metrics and Performance Insights cover dev.
  identifier                   = "${local.identifier}-writer"
  cluster_identifier           = aws_rds_cluster.this.id
  engine                       = aws_rds_cluster.this.engine
  engine_version               = aws_rds_cluster.this.engine_version
  instance_class               = "db.serverless"
  db_subnet_group_name         = aws_db_subnet_group.this.name
  publicly_accessible          = false
  auto_minor_version_upgrade   = true
  ca_cert_identifier           = "rds-ca-rsa2048-g1"
  performance_insights_enabled = true
  # 7 days is the free tier.
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = var.kms_key_arn
  tags                                  = { component = "aurora" }
}

# special = false keeps the passwords URL-safe without encoding; their presence in state is accepted (I-04).
resource "random_password" "role" {
  for_each = local.roles
  length   = 32
  special  = false
}

resource "aws_secretsmanager_secret" "role" {
  #checkov:skip=CKV2_AWS_57:Rotation deferred (I-04); bootstrap sets each role password from these secrets.
  for_each    = local.roles
  name        = "${var.name_prefix}/dev/db/${each.key}"
  description = "Aurora login for DB role ${each.key}."
  kms_key_id  = var.kms_key_arn
  tags        = { component = "aurora" }
}

resource "aws_secretsmanager_secret_version" "role" {
  for_each  = local.roles
  secret_id = aws_secretsmanager_secret.role[each.key].id
  secret_string = jsonencode(merge(
    {
      username = each.key
      password = random_password.role[each.key].result
      host     = aws_rds_cluster.this.endpoint
      port     = local.port
      dbname   = var.database_name
      url      = "postgres://${each.key}:${random_password.role[each.key].result}@${aws_rds_cluster.this.endpoint}:${local.port}/${var.database_name}?sslmode=verify-full"
    },
    # The sweeper reads the RDS secret format rather than url.
    each.key == "disputes_retention" ? { engine = "postgres" } : {},
  ))
}
