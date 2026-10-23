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
          "ec2:DescribeNetworkInsightsAnalyses",
          "ec2:DescribeNetworkInsightsPaths",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs",
          "ec2:StartNetworkInsightsAnalysis",
          "ec2:UnassignPrivateIpAddresses",
          "ecr:GetAuthorizationToken",
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
          "elasticloadbalancing:DescribeTargetHealth",
          "tiros:CreateQuery",
          "tiros:GetQueryAnswer",
          "tiros:GetQueryExplanation",
        ]
        Resource  = "*"
        Condition = local.in_region
      },
      {
        Sid    = "ReachabilityAnalyzerCleanup"
        Effect = "Allow"
        Action = ["ec2:DeleteNetworkInsightsAnalysis", "ec2:DeleteNetworkInsightsPath"]
        Resource = [
          "${local.arn.ec2}:network-insights-analysis/*",
          "${local.arn.ec2}:network-insights-path/*",
        ]
      },
      {
        Sid    = "ReachabilityAnalyzerTagOnCreate"
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
        Sid      = "PassWorkloadRolesToEcs"
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
        Resource = ["${local.arn.secrets}:secret:${local.p}/dev/seed-users/*"]
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
        Sid    = "BucketObjects"
        Effect = "Allow"
        Action = [
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:GetObjectAttributes",
          "s3:GetObjectTagging",
          "s3:GetObjectVersion",
          "s3:GetObjectVersionTagging",
          "s3:PutObject",
          "s3:PutObjectTagging",
          "s3:PutObjectVersionTagging",
        ]
        Resource = ["${local.arn.s3}*/*"]
      },
      {
        Sid    = "Buckets"
        Effect = "Allow"
        Action = [
          "s3:GetBucketLocation",
          "s3:GetBucketNotification",
          "s3:GetEncryptionConfiguration",
          "s3:ListBucket",
          "s3:PutBucketNotification",
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
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:ListUsers",
        ]
        Resource = ["${local.arn.cognito}:userpool/*"]
      },
      {
        Sid    = "LambdaDeployAndInvoke"
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
        Sid    = "GuardDutyManagedRule"
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
        Sid         = "DenyAssumeRoleOutsideWorkloadPath"
        Effect      = "Deny"
        Action      = ["sts:AssumeRole"]
        NotResource = [local.workload_role_arn_pattern]
      },
    ]
  }
}
