locals {
  # Every IAM verb except Pass*: CI deploy roles must pass their own /cd/ task roles to ECS.
  boundary_denied_iam_actions = [
    "iam:Add*",
    "iam:Attach*",
    "iam:Change*",
    "iam:Create*",
    "iam:Deactivate*",
    "iam:Delete*",
    "iam:Detach*",
    "iam:Disable*",
    "iam:Enable*",
    "iam:Generate*",
    "iam:Get*",
    "iam:List*",
    "iam:Put*",
    "iam:Remove*",
    "iam:Reset*",
    "iam:Resync*",
    "iam:Set*",
    "iam:Simulate*",
    "iam:Tag*",
    "iam:Untag*",
    "iam:Update*",
    "iam:Upload*",
  ]

  boundary_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "NoResourceLevelActions"
        Effect = "Allow"
        # None of these support resource-level permissions (ECR auth, task-def registration, VPC ENIs, describes).
        Action = [
          "cloudwatch:DescribeAlarms",
          "cloudwatch:GetMetricData",
          "cloudwatch:PutMetricData",
          "ec2:AssignPrivateIpAddresses",
          "ec2:CreateNetworkInsightsPath",
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:StartNetworkInsightsAnalysis",
          "ec2:UnassignPrivateIpAddresses",
          "ecr:GetAuthorizationToken",
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
          "tiros:CreateQuery",
          "tiros:GetQueryAnswer",
          "tiros:GetQueryExplanation",
        ]
        Resource  = "*"
        Condition = local.in_region
      },
      {
        Sid    = "ReachabilityReads"
        Effect = "Allow"
        # Ceiling for the e2e role's explicit Reachability Analyzer hop reads; read-only globs keep the boundary under 6,144 chars.
        Action = [
          "directconnect:Describe*",
          "ec2:Describe*",
          "ec2:GetManagedPrefixListEntries",
          "ec2:GetTransitGatewayRouteTablePropagations",
          "ec2:SearchTransitGatewayRoutes",
          "elasticloadbalancing:Describe*",
          "network-firewall:Describe*",
          "network-firewall:List*",
        ]
        Resource  = "*"
        Condition = local.in_region
      },
      {
        Sid    = "GlobalAcceleratorReads"
        Effect = "Allow"
        Action = [
          "globalaccelerator:List*",
        ]
        Resource = "*"
        # The Global Accelerator API is served only from us-west-2, whatever the accelerator's endpoints.
        Condition = { StringEquals = { "aws:RequestedRegion" = ["us-west-2"] } }
      },
      {
        Sid    = "InsightsCleanup"
        Effect = "Allow"
        Action = ["ec2:DeleteNetworkInsightsAnalysis", "ec2:DeleteNetworkInsightsPath"]
        Resource = [
          "${local.arn.ec2}:network-insights-analysis/*",
          "${local.arn.ec2}:network-insights-path/*",
        ]
      },
      {
        Sid    = "InsightsTagOnCreate"
        Effect = "Allow"
        Action = ["ec2:CreateTags"]
        Resource = [
          "${local.arn.ec2}:network-insights-analysis/*",
          "${local.arn.ec2}:network-insights-path/*",
        ]
        Condition = {
          StringEquals = { "ec2:CreateAction" = ["CreateNetworkInsightsPath", "StartNetworkInsightsAnalysis"] }
        }
      },
      {
        Sid    = "EcrImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = ["${local.arn.ecr}:repository/${local.p}-*"]
      },
      {
        Sid    = "EcsDeployAndRun"
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices",
          "ecs:DescribeTasks",
          "ecs:RunTask",
          "ecs:StopTask",
          "ecs:TagResource",
          "ecs:UpdateService",
        ]
        Resource = [
          "${local.arn.ecs}:cluster/${local.p}-*",
          "${local.arn.ecs}:service/${local.p}-*/*",
          "${local.arn.ecs}:task/${local.p}-*/*",
          "${local.arn.ecs}:task-definition/${local.p}-*:*",
        ]
      },
      {
        Sid      = "PassRoleToEcs"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [local.workload_role_arn_pattern]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:DescribeLogStreams",
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
          "logs:PutLogEvents",
        ]
        Resource = [
          "${local.arn.logs}:log-group:/${local.p}/*",
          "${local.arn.logs}:log-group:/aws/lambda/${local.p}-*",
        ]
      },
      {
        Sid      = "SecretsRead"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource = ["${local.arn.secrets}:secret:${local.p}/*", "${local.arn.secrets}:secret:rds!*"]
      },
      {
        Sid    = "SeedUserSecretsWrite"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
        ]
        Resource = ["${local.arn.secrets}:secret:${local.p}/dev/seed-users/*", "${local.arn.secrets}:secret:${local.p}/dev/agent-users/*"]
      },
      {
        Sid    = "KmsUse"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey",
          "kms:Encrypt",
          "kms:GenerateDataKey",
        ]
        Resource = ["${local.arn.kms}:key/*"]
      },
      {
        # Bucket and object actions share one statement to fit 6,144 chars; <prefix>* matches the same objects <prefix>*/* did.
        Sid    = "Buckets"
        Effect = "Allow"
        Action = [
          "s3:DeleteObject",
          "s3:GetBucketLocation",
          "s3:GetBucketNotification",
          "s3:GetEncryptionConfiguration",
          "s3:GetObject",
          "s3:GetObjectAttributes",
          "s3:GetObjectTagging",
          "s3:GetObjectVersion",
          "s3:GetObjectVersionTagging",
          "s3:ListBucket",
          "s3:PutBucketNotification",
          "s3:PutObject",
          "s3:PutObjectTagging",
          "s3:PutObjectVersionTagging",
        ]
        Resource = ["${local.arn.s3}*"]
      },
      {
        Sid    = "Queues"
        Effect = "Allow"
        Action = [
          "sqs:ChangeMessageVisibility",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ReceiveMessage",
          "sqs:SendMessage",
        ]
        Resource = ["${local.arn.sqs}:${local.p}-*"]
      },
      {
        Sid      = "SendEmail"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = ["${local.arn.ses}:identity/*", "${local.arn.ses}:configuration-set/${local.p}-*"]
      },
      {
        Sid    = "CognitoAdmin"
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:AdminSetUserMFAPreference",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:ListUsers",
        ]
        Resource = ["${local.arn.cognito}:userpool/*"]
      },
      {
        Sid    = "LambdaDeploy"
        Effect = "Allow"
        Action = [
          "lambda:GetAlias",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:InvokeFunction",
          "lambda:PublishVersion",
          "lambda:UpdateAlias",
          "lambda:UpdateFunctionCode",
        ]
        Resource = ["${local.arn.lambda}:function:${local.p}-*"]
      },
      {
        Sid    = "GuardDutyRule"
        Effect = "Allow"
        Action = [
          "events:DeleteRule",
          "events:DescribeRule",
          "events:ListTargetsByRule",
          "events:PutRule",
          "events:PutTargets",
          "events:RemoveTargets",
        ]
        Resource = ["${local.arn.events}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"]
      },
      {
        Sid      = "DenyIamExceptPassRole"
        Effect   = "Deny"
        Action   = local.boundary_denied_iam_actions
        Resource = "*"
      },
      {
        Sid    = "DenyOrganizations"
        Effect = "Deny"
        # Deny-only wildcard: no workload may touch AWS Organizations at all.
        Action   = ["organizations:*"]
        Resource = "*"
      },
      {
        Sid         = "DenyOtherAssumeRole"
        Effect      = "Deny"
        Action      = ["sts:AssumeRole"]
        NotResource = [local.workload_role_arn_pattern]
      },
    ]
  }
}
