locals {
  service_keys = ["auth", "users", "transactions", "disputes", "web"]
  lambda_keys  = ["evidence-intake", "dispute-notifier", "retention-sweeper"]

  # Nothing runs until an image is deployed; the pipeline or autoscaling owns the count afterwards.
  service_desired_count = 0

  lambda_timeouts = {
    evidence-intake   = 60
    dispute-notifier  = 30
    retention-sweeper = 300
  }

  sqs_via            = "sqs.${local.region}.amazonaws.com"
  s3_via             = "s3.${local.region}.amazonaws.com"
  secretsmanager_via = "secretsmanager.${local.region}.amazonaws.com"

  db_secrets = module.aurora.role_secret_arns

  # Lambdas reach users/disputes :8081 through the internal ALB (vpc_origin) or Cloud Map DNS (public_alb).
  lambda_peer_url = {
    for s in ["users", "disputes"] : s => local.vpc_origin ? module.alb.service_port_base_url : "http://${s}.${module.ecs_cluster.namespace_name}:8081"
  }

  backend_db_services = {
    auth = {
      command = ["node", "src/main.ts", "migrate"]
    }
    users = {
      command = ["node", "src/migrate.ts"]
    }
    transactions = {
      command = ["node", "src/migrate.ts"]
    }
    disputes = {
      command = ["node", "src/server.ts", "migrate"]
    }
  }

  service_client_env = {
    for s in ["users", "transactions", "disputes"] : s => {
      TOKEN_URL         = module.cognito.token_url
      SERVICE_CLIENT_ID = module.cognito.service_client_ids["svc-${s}"]
    }
  }

  service_client_secret = {
    for s in ["users", "transactions", "disputes"] : s => {
      SERVICE_CLIENT_SECRET = { secret_arn = module.cognito.service_client_secret_arns["svc-${s}"] }
    }
  }

  target_groups = {
    auth = {}
    users = merge(
      { "8080" = { arn = module.alb.target_group_arns["users-8080"], container_port = 8080 } },
      local.vpc_origin ? { "8081" = { arn = module.alb.target_group_arns["users-8081"], container_port = 8081 } } : {},
    )
    transactions = { "8080" = { arn = module.alb.target_group_arns["transactions-8080"], container_port = 8080 } }
    disputes = merge(
      { "8080" = { arn = module.alb.target_group_arns["disputes-8080"], container_port = 8080 } },
      local.vpc_origin ? { "8081" = { arn = module.alb.target_group_arns["disputes-8081"], container_port = 8081 } } : {},
    )
    web = { "8080" = { arn = module.alb.target_group_arns["web-8080"], container_port = 8080 } }
  }

  service_environment = {
    auth = {
      AUTH_ISSUER_URL         = module.cognito.issuer_url
      AUTH_JWKS_URI           = module.cognito.jwks_url
      AUTH_USER_CLIENT_IDS    = join(",", module.cognito.user_client_ids)
      AUTH_SERVICE_CLIENT_IDS = join(",", values(module.cognito.service_client_ids))
    }
    users        = local.service_client_env["users"]
    transactions = local.service_client_env["transactions"]
    disputes = merge(local.service_client_env["disputes"], {
      NOTIFICATIONS_QUEUE_URL = module.messaging.notifications_queue_url
      QUARANTINE_BUCKET       = module.evidence_buckets.quarantine_bucket_name
    })
    web = {
      OIDC_ISSUER          = module.cognito.issuer_url
      OIDC_CLIENT_ID       = module.cognito.spa_client_id
      OIDC_TOKEN_ORIGIN    = module.cognito.hosted_ui_base_url
      OIDC_LOGOUT_URL      = "${module.cognito.hosted_ui_base_url}/logout"
      OIDC_REDIRECT_URI    = "${module.edge.web_origin}/callback"
      OIDC_POST_LOGOUT_URI = "${module.edge.web_origin}/"
      UPLOAD_ORIGIN        = module.evidence_buckets.quarantine_bucket_regional_origin
    }
  }

  service_secrets = {
    auth         = { DATABASE_URL = { secret_arn = local.db_secrets["auth_app"], json_key = "url" } }
    users        = merge({ DATABASE_URL = { secret_arn = local.db_secrets["users_app"], json_key = "url" } }, local.service_client_secret["users"])
    transactions = merge({ DATABASE_URL = { secret_arn = local.db_secrets["transactions_app"], json_key = "url" } }, local.service_client_secret["transactions"])
    disputes     = merge({ DATABASE_URL = { secret_arn = local.db_secrets["disputes_app"], json_key = "url" } }, local.service_client_secret["disputes"])
    web          = {}
  }

  task_role_statements = {
    auth         = []
    users        = []
    transactions = []
    disputes = [
      {
        Sid      = "PutQuarantineIntakeObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${module.evidence_buckets.quarantine_bucket_arn}/intake/*"]
      },
      {
        # GenerateDataKey only: the evidence key policy denies this role Decrypt, so disputes can never read evidence.
        Sid       = "EncryptQuarantineUploads"
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey"]
        Resource  = [local.evidence_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = [local.s3_via] } }
      },
      {
        Sid      = "SendDisputeNotifications"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [module.messaging.notifications_queue_arn]
      },
      {
        Sid       = "EncryptDisputeNotifications"
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource  = [local.data_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = [local.sqs_via] } }
      },
    ]
    web = []
  }

  read_secret_statements = {
    for k, arn in {
      evidence-intake   = module.cognito.service_client_secret_arns["svc-evidence-intake"]
      dispute-notifier  = module.cognito.service_client_secret_arns["svc-notifier"]
      retention-sweeper = local.db_secrets["disputes_retention"]
      } : k => [
      {
        Sid      = "ReadOwnSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [arn]
      },
      {
        Sid       = "DecryptOwnSecret"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = [local.data_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = [local.secretsmanager_via] } }
      },
    ]
  }

  lambda_policy_statements = {
    evidence-intake = concat(local.read_secret_statements["evidence-intake"], [
      {
        Sid      = "ReadAndRemoveQuarantineObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:DeleteObject"]
        Resource = ["${module.evidence_buckets.quarantine_bucket_arn}/*"]
      },
      # Without ListBucket S3 answers a missing key with 403, so a redelivered event would look like denied, not gone.
      {
        Sid      = "ListQuarantineForNotFound"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [module.evidence_buckets.quarantine_bucket_arn]
      },
      {
        Sid      = "PromoteEvidenceObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${module.evidence_buckets.evidence_bucket_arn}/evidence/*"]
      },
      {
        Sid       = "UseEvidenceKey"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = [local.evidence_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = [local.s3_via] } }
      },
    ])
    dispute-notifier = concat(local.read_secret_statements["dispute-notifier"], [
      {
        Sid      = "ConsumeDisputeNotifications"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [module.messaging.notifications_queue_arn]
      },
      {
        Sid       = "DecryptDisputeNotifications"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = [local.data_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = [local.sqs_via] } }
      },
      {
        Sid       = "SendFromSenderIdentityOnly"
        Effect    = "Allow"
        Action    = ["ses:SendEmail"]
        Resource  = [module.ses.email_identity_arn, module.ses.configuration_set_arn]
        Condition = { StringEquals = { "ses:FromAddress" = [var.ses_sender] } }
      },
    ])
    retention-sweeper = local.read_secret_statements["retention-sweeper"]
  }

  lambda_environment = {
    evidence-intake = {
      QUARANTINE_BUCKET        = module.evidence_buckets.quarantine_bucket_name
      EVIDENCE_BUCKET          = module.evidence_buckets.evidence_bucket_name
      DISPUTES_SERVICE_URL     = local.lambda_peer_url["disputes"]
      TOKEN_URL                = module.cognito.token_url
      SERVICE_CLIENT_ID        = module.cognito.service_client_ids["svc-evidence-intake"]
      SERVICE_CLIENT_SECRET_ID = module.cognito.service_client_secret_arns["svc-evidence-intake"]
    }
    dispute-notifier = {
      USERS_SERVICE_URL         = local.lambda_peer_url["users"]
      DISPUTES_SERVICE_URL      = local.lambda_peer_url["disputes"]
      TOKEN_URL                 = module.cognito.token_url
      SERVICE_CLIENT_ID         = module.cognito.service_client_ids["svc-notifier"]
      SERVICE_CLIENT_SECRET_ARN = module.cognito.service_client_secret_arns["svc-notifier"]
      SES_SENDER                = var.ses_sender
    }
    retention-sweeper = {
      DATABASE_SECRET_ID = local.db_secrets["disputes_retention"]
    }
  }
}

module "service" {
  source   = "../../modules/ecs-service"
  for_each = toset(local.service_keys)

  name_prefix              = var.name_prefix
  service_name             = each.key
  permissions_boundary_arn = local.permissions_boundary_arn
  iam_path                 = local.iam_path
  log_retention_days       = var.log_retention_days
  logs_kms_key_arn         = local.data_kms_key_arn
  data_kms_key_arn         = local.data_kms_key_arn
  cluster_arn              = module.ecs_cluster.cluster_arn
  namespace_arn            = module.ecs_cluster.namespace_arn
  namespace_id             = module.ecs_cluster.namespace_id
  # Never pulled at desired 0; the deploy pipeline registers the real image.
  image_uri                  = "${module.ecr.repository_urls[each.key == "web" ? "web" : "svc-${each.key}"]}:initial"
  subnet_ids                 = module.network.private_subnet_ids
  security_group_id          = module.security.security_group_ids[each.key]
  service_connect_server     = each.key != "web"
  register_cloud_map_service = !local.vpc_origin && contains(["users", "disputes"], each.key)
  health_check_path          = each.key == "web" ? "/healthz" : "/health"
  target_groups              = local.target_groups[each.key]
  environment                = local.service_environment[each.key]
  secrets                    = local.service_secrets[each.key]
  task_role_statements       = local.task_role_statements[each.key]
  desired_count              = local.service_desired_count
  enable_autoscaling         = var.enable_service_autoscaling

  migrate = contains(keys(local.backend_db_services), each.key) ? {
    command     = local.backend_db_services[each.key].command
    environment = {}
    secrets = {
      MIGRATOR_DATABASE_URL = { secret_arn = local.db_secrets["${each.key}_migrator"], json_key = "url" }
    }
  } : null
}

module "lambda" {
  source   = "../../modules/lambda-fn"
  for_each = toset(local.lambda_keys)

  name_prefix              = var.name_prefix
  function_key             = each.key
  image_uri                = lookup(var.lambda_image_uris, each.key, null)
  permissions_boundary_arn = local.permissions_boundary_arn
  iam_path                 = local.iam_path
  log_retention_days       = var.log_retention_days
  logs_kms_key_arn         = local.data_kms_key_arn
  data_kms_key_arn         = local.data_kms_key_arn
  timeout_seconds          = local.lambda_timeouts[each.key]
  subnet_ids               = module.network.private_subnet_ids
  security_group_id        = module.security.security_group_ids[each.key]
  environment              = local.lambda_environment[each.key]
  policy_statements        = local.lambda_policy_statements[each.key]

  sqs_event_source     = each.key == "dispute-notifier" ? { queue_arn = module.messaging.notifications_queue_arn } : null
  async_on_failure_arn = each.key == "evidence-intake" ? module.messaging.evidence_intake_dlq_arn : null
  # The Scheduler already retries (schedule_max_retries), so async retries would double-run the sweep.
  async_max_retries = each.key == "retention-sweeper" ? 0 : 2
  schedule = each.key == "retention-sweeper" ? {
    expression = "cron(0 2 * * ? *)"
    timezone   = "Africa/Johannesburg"
    dlq_arn    = module.messaging.retention_scheduler_dlq_arn
  } : null
}

module "dev_tools" {
  source = "../../modules/dev-tools"

  name_prefix              = var.name_prefix
  permissions_boundary_arn = local.permissions_boundary_arn
  iam_path                 = local.iam_path
  log_retention_days       = var.log_retention_days
  logs_kms_key_arn         = local.data_kms_key_arn
  data_kms_key_arn         = local.data_kms_key_arn
  cluster_arn              = module.ecs_cluster.cluster_arn
  image_uri                = "${module.ecr.repository_urls["dev-tools"]}:initial"
  subnet_ids               = module.network.private_subnet_ids
  security_group_id        = module.security.security_group_ids["dev-tools"]
  aurora = {
    endpoint          = module.aurora.endpoint
    port              = module.aurora.port
    database_name     = module.aurora.database_name
    master_secret_arn = module.aurora.master_secret_arn
    role_secret_arns  = module.aurora.role_secret_arns
  }
  cognito_user_pool_arn        = module.cognito.user_pool_arn
  cognito_user_pool_id         = module.cognito.user_pool_id
  seed_user_secret_name_prefix = local.seed_user_secret_name_prefix

  probe_environment = merge(
    {
      TOKEN_URL         = module.cognito.token_url
      SERVICE_CLIENT_ID = module.cognito.service_client_ids["svc-notifier"]
    },
    local.vpc_origin ? { SERVICE_PORT_BASE_URL = module.alb.service_port_base_url } : {},
    var.enable_e2e_client ? { E2E_CLIENT_ID = module.cognito.e2e_client_id } : {},
  )
  probe_secrets = {
    SERVICE_CLIENT_SECRET = { secret_arn = module.cognito.service_client_secret_arns["svc-notifier"] }
  }
}
