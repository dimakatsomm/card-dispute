data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  p         = var.name_prefix

  # CloudFront-scoped WAF lives only in us-east-1.
  edge_region = "us-east-1"

  github_oidc_host = "token.actions.githubusercontent.com"
  oidc_audience    = "sts.amazonaws.com"
  plan_subject     = "repo:${var.github_repo}:ref:refs/heads/main"
  apply_subject    = "repo:${var.github_repo}:environment:dev"

  state_bucket_name = coalesce(var.state_bucket_name, "${local.p}-tfstate-${local.account}")
  state_bucket_arn  = "arn:${local.partition}:s3:::${local.state_bucket_name}"
  state_key_alias   = "alias/${local.p}-tfstate"
  state_prefix      = "envs/dev"

  plan_role_name  = "gha-infra-plan"
  apply_role_name = "gha-infra-apply"
  plan_role_arn   = "arn:${local.partition}:iam::${local.account}:role/${local.plan_role_name}"
  apply_role_arn  = "arn:${local.partition}:iam::${local.account}:role/${local.apply_role_name}"

  boundary_name             = "${local.p}-workload-boundary"
  boundary_arn              = "arn:${local.partition}:iam::${local.account}:policy/${local.boundary_name}"
  workload_role_path        = "/${local.p}/"
  workload_role_arn_pattern = "arn:${local.partition}:iam::${local.account}:role/${local.p}/*"
  oidc_provider_arn         = "arn:${local.partition}:iam::${local.account}:oidc-provider/${local.github_oidc_host}"
  read_only_policy_arn      = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"

  arn = {
    ec2       = "arn:${local.partition}:ec2:${local.region}:${local.account}"
    kms       = "arn:${local.partition}:kms:${local.region}:${local.account}"
    iam       = "arn:${local.partition}:iam::${local.account}"
    s3        = "arn:${local.partition}:s3:::${local.p}-dev-"
    ecr       = "arn:${local.partition}:ecr:${local.region}:${local.account}"
    ecs       = "arn:${local.partition}:ecs:${local.region}:${local.account}"
    sd        = "arn:${local.partition}:servicediscovery:${local.region}:${local.account}"
    elb       = "arn:${local.partition}:elasticloadbalancing:${local.region}:${local.account}"
    cf        = "arn:${local.partition}:cloudfront::${local.account}"
    waf       = "arn:${local.partition}:wafv2:${local.edge_region}:${local.account}"
    cognito   = "arn:${local.partition}:cognito-idp:${local.region}:${local.account}"
    rds       = "arn:${local.partition}:rds:${local.region}:${local.account}"
    secrets   = "arn:${local.partition}:secretsmanager:${local.region}:${local.account}"
    sqs       = "arn:${local.partition}:sqs:${local.region}:${local.account}"
    sns       = "arn:${local.partition}:sns:${local.region}:${local.account}"
    cw        = "arn:${local.partition}:cloudwatch:${local.region}:${local.account}"
    cw_global = "arn:${local.partition}:cloudwatch::${local.account}"
    logs      = "arn:${local.partition}:logs:${local.region}:${local.account}"
    lambda    = "arn:${local.partition}:lambda:${local.region}:${local.account}"
    events    = "arn:${local.partition}:events:${local.region}:${local.account}"
    scheduler = "arn:${local.partition}:scheduler:${local.region}:${local.account}"
    ses       = "arn:${local.partition}:ses:${local.region}:${local.account}"
    guardduty = "arn:${local.partition}:guardduty:${local.region}:${local.account}"
    budgets   = "arn:${local.partition}:budgets::${local.account}"
    aas       = "arn:${local.partition}:application-autoscaling:${local.region}:${local.account}"
  }

  in_region      = { StringEquals = { "aws:RequestedRegion" = [local.region] } }
  in_edge_region = { StringEquals = { "aws:RequestedRegion" = [local.edge_region] } }

  plan_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsMainBranch"
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.github_oidc_host}:aud" = local.oidc_audience
          "${local.github_oidc_host}:sub" = local.plan_subject
        }
      }
    }]
  }

  apply_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsEnvironmentDev"
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.github_oidc_host}:aud" = local.oidc_audience
          "${local.github_oidc_host}:sub" = local.apply_subject
        }
      }
    }]
  }

  # Key policy: Resource "*" means this key. Root gets explicit actions so IAM policies can delegate them.
  state_key_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AccountRootExplicitActions"
      Effect    = "Allow"
      Principal = { AWS = "arn:${local.partition}:iam::${local.account}:root" }
      Action = [
        "kms:CancelKeyDeletion",
        "kms:CreateAlias",
        "kms:CreateGrant",
        "kms:Decrypt",
        "kms:DeleteAlias",
        "kms:DescribeKey",
        "kms:DisableKey",
        "kms:DisableKeyRotation",
        "kms:EnableKey",
        "kms:EnableKeyRotation",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:GetKeyPolicy",
        "kms:GetKeyRotationStatus",
        "kms:ListGrants",
        "kms:ListKeyRotations",
        "kms:ListResourceTags",
        "kms:PutKeyPolicy",
        "kms:ReEncryptFrom",
        "kms:ReEncryptTo",
        "kms:RetireGrant",
        "kms:RevokeGrant",
        "kms:RotateKeyOnDemand",
        "kms:ScheduleKeyDeletion",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:UpdateAlias",
        "kms:UpdateKeyDescription",
      ]
      Resource = "*"
    }]
  }

  state_bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        # Deny-only wildcard: TLS must be required for every S3 action.
        Action    = "s3:*"
        Resource  = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyNonKmsObjectUploads"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.state_bucket_arn}/*"
        Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "aws:kms" } }
      },
      {
        Sid       = "DenyOtherKmsKeys"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.state_bucket_arn}/*"
        Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.state.arn } }
      },
    ]
  }

  state_key_use = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"]

  # Shared by both roles: ReadOnlyAccess would otherwise reach these.
  read_guardrail_statements = [
    {
      Sid      = "DenySeedUserSecretValues"
      Effect   = "Deny"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = ["${local.arn.secrets}:secret:${local.p}/dev/seed-users/*"]
    },
    {
      Sid    = "DenyEvidenceObjectReads"
      Effect = "Deny"
      Action = ["s3:GetObject", "s3:GetObjectVersion"]
      Resource = [
        "${local.arn.s3}evidence-*/*",
        "${local.arn.s3}quarantine-*/*",
      ]
    },
  ]

  # Terraform refresh of aws_secretsmanager_secret_version calls GetSecretValue; the values are in state anyway.
  managed_secret_value_statement = {
    Sid      = "ManagedSecretValues"
    Effect   = "Allow"
    Action   = ["secretsmanager:GetSecretValue"]
    Resource = ["${local.arn.secrets}:secret:${local.p}/*"]
  }

  managed_secret_read_statements = [
    local.managed_secret_value_statement,
    {
      Sid      = "ManagedSecretDecrypt"
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = ["${local.arn.kms}:key/*"]
      Condition = {
        StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" }
      }
    },
  ]

  plan_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "StateList"
          Effect   = "Allow"
          Action   = ["s3:ListBucket"]
          Resource = [local.state_bucket_arn]
        },
        {
          Sid      = "StateRead"
          Effect   = "Allow"
          Action   = ["s3:GetObject"]
          Resource = ["${local.state_bucket_arn}/*"]
        },
        {
          Sid      = "StateLock"
          Effect   = "Allow"
          Action   = ["s3:PutObject", "s3:DeleteObject"]
          Resource = ["${local.state_bucket_arn}/${local.state_prefix}/*.tflock"]
        },
        {
          Sid      = "StoredPlans"
          Effect   = "Allow"
          Action   = ["s3:PutObject", "s3:DeleteObject"]
          Resource = ["${local.state_bucket_arn}/plans/*"]
        },
        {
          Sid      = "StateKey"
          Effect   = "Allow"
          Action   = local.state_key_use
          Resource = [aws_kms_key.state.arn]
        },
      ],
      local.managed_secret_read_statements,
      local.read_guardrail_statements,
    )
  }
}
