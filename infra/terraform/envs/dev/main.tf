data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  iam_path = "/${var.name_prefix}/"
  # Bootstrap is a separate state, so its outputs are rebuilt from the fixed names (modules/README.md §4).
  permissions_boundary_arn = "arn:${local.partition}:iam::${local.account_id}:policy/${var.name_prefix}-workload-boundary"
  github_oidc_provider_arn = "arn:${local.partition}:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"

  vpc_origin                   = var.edge_origin_mode == "vpc_origin"
  seed_user_secret_name_prefix = "${var.name_prefix}/dev/seed-users/"
  data_kms_key_arn             = module.security.kms_key_arns["data"]
  evidence_kms_key_arn         = module.security.kms_key_arns["evidence"]
}

module "network" {
  source = "../../modules/network"

  name_prefix = var.name_prefix
  vpc_cidr    = var.vpc_cidr
}

module "security" {
  source = "../../modules/security"

  name_prefix       = var.name_prefix
  vpc_id            = module.network.vpc_id
  s3_prefix_list_id = module.network.s3_prefix_list_id
  edge_origin_mode  = var.edge_origin_mode
}

module "ecr" {
  source = "../../modules/ecr"

  name_prefix = var.name_prefix
  kms_key_arn = local.data_kms_key_arn
}

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name_prefix = var.name_prefix
  vpc_id      = module.network.vpc_id
}

module "aurora" {
  source = "../../modules/aurora"

  name_prefix         = var.name_prefix
  subnet_ids          = module.network.private_subnet_ids
  security_group_id   = module.security.security_group_ids["aurora"]
  kms_key_arn         = local.data_kms_key_arn
  logs_kms_key_arn    = local.data_kms_key_arn
  min_acu             = var.aurora_min_acu
  max_acu             = var.aurora_max_acu
  deletion_protection = var.deletion_protection
  log_retention_days  = var.log_retention_days
}

module "messaging" {
  source = "../../modules/messaging"

  name_prefix              = var.name_prefix
  kms_key_arn              = local.data_kms_key_arn
  notifier_timeout_seconds = local.lambda_timeouts["dispute-notifier"]
  # Roles that exist in phase A, so the allow-list Deny never refuses every producer (ADR-066).
  allowed_sender_role_arns      = [module.service["disputes"].task_role_arn]
  allowed_consumer_role_arns    = [module.lambda["dispute-notifier"].role_arn]
  evidence_intake_role_arns     = [module.lambda["evidence-intake"].role_arn]
  retention_scheduler_role_arns = [module.lambda["retention-sweeper"].scheduler_role_arn]
  evidence_scan_rule_arn        = module.evidence_buckets.scan_result_rule_arn
}

module "ses" {
  source = "../../modules/ses"

  name_prefix  = var.name_prefix
  sender_email = var.ses_sender
  kms_key_arn  = local.data_kms_key_arn
}

module "alb" {
  source = "../../modules/alb"

  name_prefix        = var.name_prefix
  edge_origin_mode   = var.edge_origin_mode
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids
  security_group_id  = module.security.security_group_ids["alb"]
  data_kms_key_arn   = local.data_kms_key_arn
}

module "edge" {
  source = "../../modules/edge"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix                = var.name_prefix
  edge_origin_mode           = var.edge_origin_mode
  alb_arn                    = module.alb.alb_arn
  alb_dns_name               = module.alb.alb_dns_name
  alb_security_group_id      = module.security.security_group_ids["alb"]
  origin_secret_header_value = local.vpc_origin ? null : module.alb.origin_secret_header_value
}

module "cognito" {
  source = "../../modules/cognito"

  name_prefix         = var.name_prefix
  callback_urls       = ["${module.edge.web_origin}/callback"]
  logout_urls         = ["${module.edge.web_origin}/"]
  enable_e2e_client   = var.enable_e2e_client
  secrets_kms_key_arn = local.data_kms_key_arn
}

module "evidence_buckets" {
  source = "../../modules/evidence-buckets"

  name_prefix              = var.name_prefix
  permissions_boundary_arn = local.permissions_boundary_arn
  iam_path                 = local.iam_path
  kms_key_arn              = local.evidence_kms_key_arn
  allowed_upload_origin    = module.edge.web_origin
  enable_intake_target     = contains(keys(var.lambda_image_uris), "evidence-intake")
  intake_function_name     = module.lambda["evidence-intake"].function_name
  intake_alias_arn         = module.lambda["evidence-intake"].alias_arn
  intake_dlq_arn           = module.messaging.evidence_intake_dlq_arn
}

module "ci_roles" {
  source = "../../modules/ci-roles"

  name_prefix              = var.name_prefix
  permissions_boundary_arn = local.permissions_boundary_arn
  iam_path                 = local.iam_path
  github_repo              = var.github_repo
  github_oidc_provider_arn = local.github_oidc_provider_arn
  ecr_repository_arns      = module.ecr.repository_arns
  ecs_cluster_arn          = module.ecs_cluster.cluster_arn
  ecs_deployables = {
    for k, s in module.service : k => {
      service_arn              = s.service_arn
      task_definition_families = compact([s.task_definition_family, s.migrate_task_definition_family])
      pass_role_arns           = [s.task_role_arn, s.execution_role_arn]
    }
  }
  # All three keys even without an image: deploy roles exist before the functions (ADR-066).
  lambda_function_names = { for k in local.lambda_keys : k => "${var.name_prefix}-${k}" }
  dev_tools = {
    task_definition_families = values(module.dev_tools.task_definition_families)
    pass_role_arns           = concat(values(module.dev_tools.task_role_arns), values(module.dev_tools.execution_role_arns))
  }
  cognito_user_pool_arn        = module.cognito.user_pool_arn
  seed_user_secret_name_prefix = local.seed_user_secret_name_prefix
  ses_events_queue_arn         = module.ses.ses_events_queue_arn
  evidence_bucket_arns         = [module.evidence_buckets.quarantine_bucket_arn, module.evidence_buckets.evidence_bucket_arn]
  data_kms_key_arn             = local.data_kms_key_arn
}

module "observability" {
  source = "../../modules/observability"

  name_prefix               = var.name_prefix
  alert_email               = var.alert_email
  budget_usd                = var.budget_usd
  kms_key_arn               = local.data_kms_key_arn
  dlq_names                 = module.messaging.dlq_names
  alb_arn_suffix            = module.alb.alb_arn_suffix
  target_group_arn_suffixes = module.alb.target_group_arn_suffixes
  aurora_cluster_identifier = module.aurora.cluster_identifier
  aurora_max_acu            = var.aurora_max_acu
  lambda_function_names = {
    for k in local.lambda_keys : k => module.lambda[k].function_name if contains(keys(var.lambda_image_uris), k)
  }
}
