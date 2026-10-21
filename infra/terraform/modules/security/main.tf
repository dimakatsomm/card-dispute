data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_partition" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  region       = data.aws_region.current.region
  partition    = data.aws_partition.current.partition
  account_root = "arn:${local.partition}:iam::${local.account_id}:root"

  # Built from the fixed role naming contract so the key policy needs no ARN from ecs-service (no cycle).
  disputes_task_role_arn = "arn:${local.partition}:iam::${local.account_id}:role/${var.name_prefix}/${var.name_prefix}-disputes-task"

  admin_actions = [
    "kms:CancelKeyDeletion",
    "kms:CreateAlias",
    "kms:DeleteAlias",
    "kms:DescribeKey",
    "kms:DisableKey",
    "kms:EnableKey",
    "kms:EnableKeyRotation",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:ListAliases",
    "kms:ListGrants",
    "kms:ListKeyPolicies",
    "kms:ListKeyRotations",
    "kms:ListResourceTags",
    "kms:PutKeyPolicy",
    "kms:RevokeGrant",
    "kms:RotateKeyOnDemand",
    "kms:ScheduleKeyDeletion",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:UpdateAlias",
    "kms:UpdateKeyDescription",
  ]

  use_actions = [
    "kms:Decrypt",
    "kms:DescribeKey",
    "kms:Encrypt",
    "kms:GenerateDataKey",
    "kms:GenerateDataKeyWithoutPlaintext",
    "kms:ReEncryptFrom",
    "kms:ReEncryptTo",
  ]

  # In a key policy Resource "*" means this key (contract §1 IAM exception).
  admin_statement = {
    Sid       = "AccountRootAdmin"
    Effect    = "Allow"
    Principal = { AWS = local.account_root }
    Action    = local.admin_actions
    Resource  = "*"
  }

  data_via_services = [for svc in ["secretsmanager", "sqs", "rds", "ecr", "sns"] : "${svc}.${local.region}.amazonaws.com"]

  data_key_policy = {
    Version = "2012-10-17"
    Statement = [
      local.admin_statement,
      {
        Sid       = "AccountUseViaDataServices"
        Effect    = "Allow"
        Principal = { AWS = local.account_root }
        Action    = local.use_actions
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = local.account_id
            "kms:ViaService"    = local.data_via_services
          }
        }
      },
      {
        Sid       = "AccountGrantsForAwsResources"
        Effect    = "Allow"
        Principal = { AWS = local.account_root }
        Action    = ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"]
        Resource  = "*"
        Condition = {
          Bool         = { "kms:GrantIsForAWSResource" = "true" }
          StringEquals = { "kms:ViaService" = local.data_via_services }
        }
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${local.region}.amazonaws.com" }
        Action    = local.use_actions
        Resource  = "*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = [
              "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/${var.name_prefix}/*",
              "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${var.name_prefix}-*",
              "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/rds/cluster/${var.name_prefix}-*",
            ]
          }
        }
      },
      {
        Sid       = "EventBridgeToEncryptedQueues"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
      {
        Sid       = "CloudWatchAlarmsToEncryptedTopic"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
      {
        Sid       = "BudgetsToEncryptedTopic"
        Effect    = "Allow"
        Principal = { Service = "budgets.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
    ]
  }

  s3_via_service = "s3.${local.region}.amazonaws.com"

  evidence_key_policy = {
    Version = "2012-10-17"
    Statement = [
      local.admin_statement,
      {
        Sid       = "AccountUseViaS3"
        Effect    = "Allow"
        Principal = { AWS = local.account_root }
        Action    = local.use_actions
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = local.account_id
            "kms:ViaService"    = local.s3_via_service
          }
        }
      },
      {
        Sid       = "DisputesTaskSignsQuarantinePuts"
        Effect    = "Allow"
        Principal = { AWS = local.account_root }
        Action    = ["kms:GenerateDataKey"]
        Resource  = "*"
        Condition = {
          ArnEquals    = { "aws:PrincipalArn" = local.disputes_task_role_arn }
          StringEquals = { "kms:ViaService" = local.s3_via_service }
        }
      },
      {
        # Disputes signs upload URLs only; it must never be able to read evidence (CLAUDE.md §7).
        Sid       = "DenyDisputesTaskDecrypt"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = ["kms:CreateGrant", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo"]
        Resource  = "*"
        Condition = { ArnEquals = { "aws:PrincipalArn" = local.disputes_task_role_arn } }
      },
    ]
  }

  keys = {
    data = {
      description = "Aurora, Secrets Manager, SQS, CloudWatch Logs, SNS, ECR"
      policy      = local.data_key_policy
    }
    evidence = {
      description = "Quarantine and evidence buckets"
      policy      = local.evidence_key_policy
    }
  }
}

resource "aws_kms_key" "this" {
  for_each = local.keys

  description             = "${var.name_prefix}-${each.key}: ${each.value.description}"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy                  = jsonencode(each.value.policy)

  tags = { component = "security" }
}

resource "aws_kms_alias" "this" {
  for_each = local.keys

  name          = "alias/${var.name_prefix}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}

locals {
  sg_descriptions = {
    alb                 = "ALB: :80 from CloudFront (rule in edge), :8081 from Lambdas (vpc_origin)"
    auth                = "auth service"
    users               = "users service"
    transactions        = "transactions service"
    disputes            = "disputes service"
    web                 = "web (nginx SPA)"
    "evidence-intake"   = "evidence-intake Lambda"
    "dispute-notifier"  = "dispute-notifier Lambda"
    "retention-sweeper" = "retention-sweeper Lambda"
    aurora              = "Aurora PostgreSQL"
    "dev-tools"         = "dev-tools one-shot tasks"
  }

  vpc_origin       = var.edge_origin_mode == "vpc_origin"
  backend_services = ["auth", "users", "transactions", "disputes"]
  service_callers  = ["evidence-intake", "dispute-notifier"]

  lambda_service_port_flows = local.vpc_origin ? concat(
    [for from in local.service_callers : { from = from, to = "alb", port = 8081 }],
    [for to in ["users", "disputes"] : { from = "alb", to = to, port = 8081 }],
  ) : [for pair in setproduct(local.service_callers, ["users", "disputes"]) : { from = pair[0], to = pair[1], port = 8081 }]

  flows = concat(
    [for to in ["users", "transactions", "disputes", "web"] : { from = "alb", to = to, port = 8080 }],
    [for from in ["users", "transactions", "disputes"] : { from = from, to = "auth", port = 8081 }],
    [for from in ["transactions", "disputes"] : { from = from, to = "users", port = 8081 }],
    [
      { from = "disputes", to = "transactions", port = 8081 },
      { from = "transactions", to = "disputes", port = 8081 },
    ],
    [for from in concat(local.backend_services, ["retention-sweeper", "dev-tools"]) : { from = from, to = "aurora", port = 5432 }],
    local.lambda_service_port_flows,
  )

  flow_rules = { for f in local.flows : "${f.from}-to-${f.to}-${f.port}" => f }

  internet_egress = toset([
    "auth", "users", "transactions", "disputes", "web",
    "evidence-intake", "dispute-notifier", "retention-sweeper", "dev-tools",
  ])

  # Explicit so S3 (ECR layers, evidence objects) stays reachable if the NAT :443 rule is ever narrowed.
  s3_egress = toset(["auth", "users", "transactions", "disputes", "web", "dev-tools", "evidence-intake"])
}

resource "aws_security_group" "this" {
  for_each = local.sg_descriptions

  name        = "${var.name_prefix}-${each.key}"
  description = each.value
  vpc_id      = var.vpc_id

  tags = {
    Name      = "${var.name_prefix}-${each.key}"
    component = "security"
  }
}

resource "aws_vpc_security_group_ingress_rule" "flow" {
  for_each = local.flow_rules

  security_group_id            = aws_security_group.this[each.value.to].id
  referenced_security_group_id = aws_security_group.this[each.value.from].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "from ${each.value.from}"
}

resource "aws_vpc_security_group_egress_rule" "flow" {
  for_each = local.flow_rules

  security_group_id            = aws_security_group.this[each.value.from].id
  referenced_security_group_id = aws_security_group.this[each.value.to].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "to ${each.value.to}"
}

resource "aws_vpc_security_group_egress_rule" "https_internet" {
  for_each = local.internet_egress

  security_group_id = aws_security_group.this[each.key].id
  # No interface endpoints: Cognito, Secrets Manager, ECR, Logs, SES and SQS are reached via NAT (docs/06).
  cidr_ipv4   = "0.0.0.0/0"
  ip_protocol = "tcp"
  from_port   = 443
  to_port     = 443
  description = "HTTPS via NAT to AWS APIs and Cognito"
}

resource "aws_vpc_security_group_egress_rule" "https_s3" {
  for_each = local.s3_egress

  security_group_id = aws_security_group.this[each.key].id
  prefix_list_id    = var.s3_prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to S3 gateway endpoint"
}
