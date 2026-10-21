data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  p         = var.name_prefix
  region    = data.aws_region.current.region
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition

  service_keys = ["auth", "users", "transactions", "disputes", "web"]
  lambda_keys  = ["evidence-intake", "dispute-notifier", "retention-sweeper"]
  tool_keys    = ["db-bootstrap", "dev-seed", "net-probe"]
  repo_keys = [
    "svc-auth", "svc-users", "svc-transactions", "svc-disputes", "web",
    "lambda-evidence-intake", "lambda-dispute-notifier", "lambda-retention-sweeper",
    "dev-tools",
  ]

  github_oidc_host = "token.actions.githubusercontent.com"
  oidc_audience    = "sts.amazonaws.com"
  main_subject     = "repo:${var.github_repo}:ref:refs/heads/main"
  env_subject      = "repo:${var.github_repo}:environment:dev"

  arn = {
    ec2     = "arn:${local.partition}:ec2:${local.region}:${local.account}"
    ecs     = "arn:${local.partition}:ecs:${local.region}:${local.account}"
    logs    = "arn:${local.partition}:logs:${local.region}:${local.account}"
    lambda  = "arn:${local.partition}:lambda:${local.region}:${local.account}"
    sqs     = "arn:${local.partition}:sqs:${local.region}:${local.account}"
    secrets = "arn:${local.partition}:secretsmanager:${local.region}:${local.account}"
    cw      = "arn:${local.partition}:cloudwatch:${local.region}:${local.account}"
  }

  in_cluster       = { ArnEquals = { "ecs:cluster" = var.ecs_cluster_arn } }
  cluster_tasks    = "${replace(var.ecs_cluster_arn, ":cluster/", ":task/")}/*"
  passed_to_ecs    = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
  log_group        = { for k, name in merge({ for s in local.service_keys : "ecs/${s}" => "/${local.p}/dev/ecs/${s}" }, { for t in local.tool_keys : "tools/${t}" => "/${local.p}/dev/tools/${t}" }) : k => "${local.arn.logs}:log-group:${name}:*" }
  logs_read        = ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"]
  task_definitions = { for f in distinct(concat(flatten([for d in values(var.ecs_deployables) : d.task_definition_families]), var.dev_tools.task_definition_families, ["${local.p}-net-probe"])) : f => "${local.arn.ecs}:task-definition/${f}:*" }

  # Built from names, not module outputs, so the roles exist before the functions and queues (ADR-066).
  function_arns = { for k in local.lambda_keys : k => "${local.arn.lambda}:function:${var.lambda_function_names[k]}" }
  observed_queue_arns = [
    "${local.arn.sqs}:${local.p}-dispute-notifications",
    "${local.arn.sqs}:${local.p}-dispute-notifications-dlq",
    "${local.arn.sqs}:${local.p}-evidence-intake-dlq",
    "${local.arn.sqs}:${local.p}-retention-scheduler-dlq",
  ]

  # dev-tools names its roles <prefix>-<tool>-task / -exec, like ecs-service.
  net_probe_pass_role_arns = [for a in var.dev_tools.pass_role_arns : a if strcontains(a, ":role${var.iam_path}${local.p}-net-probe-")]

  insights_tag_key   = "created-by"
  e2e_role_name      = "${local.p}-gha-e2e"
  insights_resources = ["${local.arn.ec2}:network-insights-path/*", "${local.arn.ec2}:network-insights-analysis/*"]

  ecr_auth_statement = {
    Sid    = "EcrAuthToken"
    Effect = "Allow"
    Action = ["ecr:GetAuthorizationToken"]
    # GetAuthorizationToken has no resource-level permission.
    Resource = ["*"]
  }

  publish_statements = {
    for r in local.repo_keys : "publish-${r}" => [
      local.ecr_auth_statement,
      {
        Sid    = "PushOwnRepository"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = [var.ecr_repository_arns[r]]
      },
    ]
  }

  ecs_deploy_statements = {
    for s in local.service_keys : "deploy-${s}" => [
      {
        Sid    = "TaskDefinitions"
        Effect = "Allow"
        Action = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
        # Neither action supports resource-level permissions.
        Resource = ["*"]
      },
      {
        Sid       = "UpdateOwnService"
        Effect    = "Allow"
        Action    = ["ecs:DescribeServices", "ecs:UpdateService"]
        Resource  = [var.ecs_deployables[s].service_arn]
        Condition = local.in_cluster
      },
      {
        Sid       = "RunOwnTasks"
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = [for f in var.ecs_deployables[s].task_definition_families : local.task_definitions[f]]
        Condition = local.in_cluster
      },
      {
        Sid       = "DescribeClusterTasks"
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks"]
        Resource  = [local.cluster_tasks]
        Condition = local.in_cluster
      },
      {
        Sid       = "PassOwnTaskRoles"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = var.ecs_deployables[s].pass_role_arns
        Condition = local.passed_to_ecs
      },
      {
        Sid      = "ReadOwnLogs"
        Effect   = "Allow"
        Action   = local.logs_read
        Resource = [local.log_group["ecs/${s}"]]
      },
      {
        Sid    = "TargetHealth"
        Effect = "Allow"
        Action = ["elasticloadbalancing:DescribeTargetHealth"]
        # DescribeTargetHealth has no resource-level permission.
        Resource = ["*"]
      },
    ]
  }

  lambda_deploy_statements = {
    for k in local.lambda_keys : "deploy-lambda-${k}" => [
      {
        Sid    = "DeployOwnFunction"
        Effect = "Allow"
        Action = [
          "lambda:GetAlias",
          "lambda:GetFunction",
          "lambda:PublishVersion",
          "lambda:UpdateAlias",
          "lambda:UpdateFunctionCode",
        ]
        Resource = [local.function_arns[k], "${local.function_arns[k]}:live"]
      },
      {
        Sid      = "ReadOwnRepository"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer"]
        Resource = [var.ecr_repository_arns["lambda-${k}"]]
      },
    ]
  }

  run_tools_statements = [
    {
      Sid       = "RunToolTasks"
      Effect    = "Allow"
      Action    = ["ecs:RunTask"]
      Resource  = [for f in var.dev_tools.task_definition_families : local.task_definitions[f]]
      Condition = local.in_cluster
    },
    {
      Sid       = "DescribeClusterTasks"
      Effect    = "Allow"
      Action    = ["ecs:DescribeTasks"]
      Resource  = [local.cluster_tasks]
      Condition = local.in_cluster
    },
    {
      Sid       = "PassToolRoles"
      Effect    = "Allow"
      Action    = ["iam:PassRole"]
      Resource  = var.dev_tools.pass_role_arns
      Condition = local.passed_to_ecs
    },
    {
      Sid      = "ReadToolLogs"
      Effect   = "Allow"
      Action   = local.logs_read
      Resource = [for t in local.tool_keys : local.log_group["tools/${t}"]]
    },
  ]

  e2e_statements = [
    {
      Sid      = "SeedUserAuth"
      Effect   = "Allow"
      Action   = ["cognito-idp:AdminInitiateAuth"]
      Resource = [var.cognito_user_pool_arn]
    },
    {
      Sid    = "SeedUserSecrets"
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      # Partial wildcard: dev-seed creates these secrets at run time.
      Resource = ["${local.arn.secrets}:secret:${var.seed_user_secret_name_prefix}*"]
    },
    {
      Sid      = "DecryptSecretsAndQueues"
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = [var.data_kms_key_arn]
      Condition = {
        StringEquals = { "kms:ViaService" = ["secretsmanager.${local.region}.amazonaws.com", "sqs.${local.region}.amazonaws.com"] }
      }
    },
    {
      Sid      = "ConsumeSesEvents"
      Effect   = "Allow"
      Action   = ["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
      Resource = [var.ses_events_queue_arn]
    },
    {
      Sid      = "QueueDepths"
      Effect   = "Allow"
      Action   = ["sqs:GetQueueAttributes"]
      Resource = local.observed_queue_arns
    },
    {
      Sid      = "ListEvidenceBuckets"
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = var.evidence_bucket_arns
    },
    {
      Sid    = "HeadEvidenceObjects"
      Effect = "Allow"
      # HeadObject is authorised as GetObject; without kms:Decrypt via S3 the SSE-KMS bodies stay unreadable.
      Action   = ["s3:GetObject"]
      Resource = [for b in var.evidence_bucket_arns : "${b}/*"]
    },
    {
      Sid      = "DescribeAlarms"
      Effect   = "Allow"
      Action   = ["cloudwatch:DescribeAlarms"]
      Resource = ["${local.arn.cw}:alarm:${local.p}-*"]
    },
    {
      Sid    = "ReachabilityCreate"
      Effect = "Allow"
      Action = ["ec2:CreateNetworkInsightsPath", "ec2:StartNetworkInsightsAnalysis"]
      # Listed as a * exception in modules/README.md; the tag condition marks what this role may later delete.
      Resource  = ["*"]
      Condition = { StringEquals = { "aws:RequestTag/${local.insights_tag_key}" = local.e2e_role_name } }
    },
    {
      Sid       = "ReachabilityTagOnCreate"
      Effect    = "Allow"
      Action    = ["ec2:CreateTags"]
      Resource  = local.insights_resources
      Condition = { StringEquals = { "ec2:CreateAction" = ["CreateNetworkInsightsPath", "StartNetworkInsightsAnalysis"] } }
    },
    {
      Sid    = "ReachabilityRead"
      Effect = "Allow"
      Action = [
        "ec2:DescribeNetworkInsightsAnalyses",
        "ec2:DescribeNetworkInsightsPaths",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
      ]
      # EC2 Describe actions have no resource-level permission.
      Resource = ["*"]
    },
    {
      Sid       = "ReachabilityCleanupOwn"
      Effect    = "Allow"
      Action    = ["ec2:DeleteNetworkInsightsAnalysis", "ec2:DeleteNetworkInsightsPath"]
      Resource  = local.insights_resources
      Condition = { StringEquals = { "aws:ResourceTag/${local.insights_tag_key}" = local.e2e_role_name } }
    },
    {
      Sid       = "RunNetProbe"
      Effect    = "Allow"
      Action    = ["ecs:RunTask"]
      Resource  = [local.task_definitions["${local.p}-net-probe"]]
      Condition = local.in_cluster
    },
    {
      Sid       = "DescribeClusterTasks"
      Effect    = "Allow"
      Action    = ["ecs:DescribeTasks"]
      Resource  = [local.cluster_tasks]
      Condition = local.in_cluster
    },
    {
      Sid       = "PassNetProbeRoles"
      Effect    = "Allow"
      Action    = ["iam:PassRole"]
      Resource  = local.net_probe_pass_role_arns
      Condition = local.passed_to_ecs
    },
    {
      Sid      = "ReadNetProbeLogs"
      Effect   = "Allow"
      Action   = local.logs_read
      Resource = [local.log_group["tools/net-probe"]]
    },
  ]

  roles = merge(
    { for k, st in local.publish_statements : k => { subject = local.main_subject, statements = st } },
    { for k, st in local.ecs_deploy_statements : k => { subject = local.env_subject, statements = st } },
    { for k, st in local.lambda_deploy_statements : k => { subject = local.env_subject, statements = st } },
    { "run-tools" = { subject = local.env_subject, statements = local.run_tools_statements } },
    { "e2e" = { subject = local.env_subject, statements = local.e2e_statements } },
  )
}

resource "aws_iam_role" "this" {
  for_each = local.roles

  name                 = "${local.p}-gha-${each.key}"
  path                 = var.iam_path
  description          = "GitHub Actions ${each.key} (OIDC sub ${each.value.subject})."
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
  tags                 = { component = "ci-roles" }

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsOidc"
      Effect    = "Allow"
      Principal = { Federated = var.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.github_oidc_host}:aud" = local.oidc_audience
          "${local.github_oidc_host}:sub" = each.value.subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "this" {
  for_each = local.roles

  name   = "${local.p}-gha-${each.key}"
  role   = aws_iam_role.this[each.key].name
  policy = jsonencode({ Version = "2012-10-17", Statement = each.value.statements })

  lifecycle {
    precondition {
      condition     = each.key != "e2e" || length(local.net_probe_pass_role_arns) == 2
      error_message = "dev_tools.pass_role_arns must contain the net-probe task and execution roles (<prefix>-net-probe-task, -exec)."
    }
  }
}
