locals {
  apply_policy_names = ["guardrails", "state-iam", "network-edge", "compute", "data"]

  apply_policies = {
    for name in local.apply_policy_names : name => {
      Version   = "2012-10-17"
      Statement = local.apply_statements[name]
    }
  }

  apply_policy_arns = [for name in local.apply_policy_names : "${local.arn.iam}:policy/${local.apply_role_name}-${name}"]

  apply_statements = {
    guardrails = concat(
      [
        {
          Sid    = "DenyOutsideAllowedRegions"
          Effect = "Deny"
          # AWS's documented region-guard pattern: NotAction exempts global services, so Resource must be "*".
          NotAction = ["iam:*", "sts:*", "cloudfront:*", "route53:*", "budgets:*", "support:*"]
          Resource  = "*"
          Condition = { StringNotEquals = { "aws:RequestedRegion" = [local.region, local.edge_region] } }
        },
        {
          Sid    = "DenyBootstrapRoleChanges"
          Effect = "Deny"
          Action = [
            "iam:AttachRolePolicy",
            "iam:DeleteRole",
            "iam:DeleteRolePermissionsBoundary",
            "iam:DeleteRolePolicy",
            "iam:DetachRolePolicy",
            "iam:PutRolePermissionsBoundary",
            "iam:PutRolePolicy",
            "iam:TagRole",
            "iam:UntagRole",
            "iam:UpdateAssumeRolePolicy",
            "iam:UpdateRole",
            "iam:UpdateRoleDescription",
          ]
          Resource = [local.plan_role_arn, local.apply_role_arn]
        },
        {
          Sid    = "DenyBootstrapPolicyChanges"
          Effect = "Deny"
          Action = [
            "iam:CreatePolicyVersion",
            "iam:DeletePolicy",
            "iam:DeletePolicyVersion",
            "iam:SetDefaultPolicyVersion",
            "iam:TagPolicy",
            "iam:UntagPolicy",
          ]
          Resource = concat([local.boundary_arn], local.apply_policy_arns)
        },
        {
          Sid    = "DenyOidcProviderChanges"
          Effect = "Deny"
          Action = [
            "iam:AddClientIDToOpenIDConnectProvider",
            "iam:DeleteOpenIDConnectProvider",
            "iam:RemoveClientIDFromOpenIDConnectProvider",
            "iam:TagOpenIDConnectProvider",
            "iam:UntagOpenIDConnectProvider",
            "iam:UpdateOpenIDConnectProviderThumbprint",
          ]
          Resource = [local.oidc_provider_arn]
        },
        {
          Sid      = "DenyBoundaryRemoval"
          Effect   = "Deny"
          Action   = ["iam:DeleteRolePermissionsBoundary"]
          Resource = ["${local.arn.iam}:role/*"]
        },
        {
          Sid    = "DenyStateBucketChanges"
          Effect = "Deny"
          Action = [
            "s3:DeleteBucket",
            "s3:DeleteBucketPolicy",
            "s3:DeleteObjectVersion",
            "s3:PutBucketAcl",
            "s3:PutBucketObjectLockConfiguration",
            "s3:PutBucketOwnershipControls",
            "s3:PutBucketPolicy",
            "s3:PutBucketPublicAccessBlock",
            "s3:PutBucketVersioning",
            "s3:PutEncryptionConfiguration",
            "s3:PutLifecycleConfiguration",
            "s3:PutReplicationConfiguration",
          ]
          Resource = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        },
        {
          Sid    = "DenyStateKeyChanges"
          Effect = "Deny"
          Action = [
            "kms:CreateAlias",
            "kms:CreateGrant",
            "kms:DeleteAlias",
            "kms:DisableKey",
            "kms:DisableKeyRotation",
            "kms:PutKeyPolicy",
            "kms:ScheduleKeyDeletion",
            "kms:UpdateAlias",
          ]
          Resource = [aws_kms_key.state.arn, "${local.arn.kms}:${local.state_key_alias}"]
        },
      ],
      local.read_guardrail_statements,
    )

    state-iam = concat(
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
          Action   = ["s3:GetObject", "s3:GetObjectVersion"]
          Resource = ["${local.state_bucket_arn}/*"]
        },
        {
          Sid      = "StateWrite"
          Effect   = "Allow"
          Action   = ["s3:PutObject"]
          Resource = ["${local.state_bucket_arn}/${local.state_prefix}/*"]
        },
        {
          Sid    = "StateLockAndPlanCleanup"
          Effect = "Allow"
          Action = ["s3:DeleteObject"]
          Resource = [
            "${local.state_bucket_arn}/${local.state_prefix}/*.tflock",
            "${local.state_bucket_arn}/plans/*",
          ]
        },
        {
          Sid      = "StateKey"
          Effect   = "Allow"
          Action   = local.state_key_use
          Resource = [aws_kms_key.state.arn]
        },
        {
          Sid    = "CreateWorkloadRoleWithBoundary"
          Effect = "Allow"
          Action = [
            "iam:AttachRolePolicy",
            "iam:CreateRole",
            "iam:DeleteRolePolicy",
            "iam:DetachRolePolicy",
            "iam:PutRolePermissionsBoundary",
            "iam:PutRolePolicy",
          ]
          Resource  = ["${local.arn.iam}:role${local.workload_role_path}${local.p}-*"]
          Condition = { StringEquals = { "iam:PermissionsBoundary" = local.boundary_arn } }
        },
        {
          Sid    = "ManageWorkloadRole"
          Effect = "Allow"
          Action = [
            "iam:DeleteRole",
            "iam:TagRole",
            "iam:UntagRole",
            "iam:UpdateAssumeRolePolicy",
            "iam:UpdateRole",
            "iam:UpdateRoleDescription",
          ]
          Resource = ["${local.arn.iam}:role${local.workload_role_path}${local.p}-*"]
        },
        {
          Sid      = "PassWorkloadRole"
          Effect   = "Allow"
          Action   = ["iam:PassRole"]
          Resource = [local.workload_role_arn_pattern]
          Condition = {
            StringEquals = {
              "iam:PassedToService" = [
                "ecs-tasks.amazonaws.com",
                "events.amazonaws.com",
                "lambda.amazonaws.com",
                "malware-protection-plan.guardduty.amazonaws.com",
                "scheduler.amazonaws.com",
              ]
            }
          }
        },
        {
          Sid      = "ServiceLinkedRoles"
          Effect   = "Allow"
          Action   = ["iam:CreateServiceLinkedRole"]
          Resource = ["${local.arn.iam}:role/aws-service-role/*"]
          Condition = {
            StringEquals = {
              "iam:AWSServiceName" = [
                "ecs.amazonaws.com",
                "ecs.application-autoscaling.amazonaws.com",
                "elasticloadbalancing.amazonaws.com",
                "malware-protection.guardduty.amazonaws.com",
                "rds.amazonaws.com",
                "vpcorigin.cloudfront.amazonaws.com",
              ]
            }
          }
        },
        {
          Sid    = "ManageWorkloadKeys"
          Effect = "Allow"
          Action = [
            "kms:CreateAlias",
            "kms:DeleteAlias",
            "kms:DescribeKey",
            "kms:EnableKeyRotation",
            "kms:PutKeyPolicy",
            "kms:ScheduleKeyDeletion",
            "kms:TagResource",
            "kms:UntagResource",
            "kms:UpdateAlias",
            "kms:UpdateKeyDescription",
          ]
          Resource  = ["${local.arn.kms}:key/*", "${local.arn.kms}:alias/${local.p}-*"]
          Condition = local.in_region
        },
        {
          Sid       = "KmsGrantsForAwsServices"
          Effect    = "Allow"
          Action    = ["kms:CreateGrant"]
          Resource  = ["${local.arn.kms}:key/*"]
          Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
        },
        {
          Sid      = "KmsForManagedSecrets"
          Effect   = "Allow"
          Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
          Resource = ["${local.arn.kms}:key/*"]
          Condition = {
            StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" }
          }
        },
        {
          Sid    = "NoResourceLevelCreate"
          Effect = "Allow"
          # These create actions support no resource-level permissions (the resource does not exist yet);
          # Cloud Map authorises tag-on-create TagResource before the namespace ARN exists.
          Action = [
            "cognito-idp:CreateUserPool",
            "ecs:DeregisterTaskDefinition",
            "ecs:RegisterTaskDefinition",
            "kms:CreateKey",
            "servicediscovery:CreatePrivateDnsNamespace",
            "servicediscovery:TagResource",
          ]
          Resource  = "*"
          Condition = local.in_region
        },
        {
          Sid    = "EventSourceMappingCreate"
          Effect = "Allow"
          # No resource-level permission; scoped by the target function instead.
          Action    = ["lambda:CreateEventSourceMapping"]
          Resource  = "*"
          Condition = { ArnLike = { "lambda:FunctionArn" = "${local.arn.lambda}:function:${local.p}-*" } }
        },
        {
          Sid    = "HostedZoneCreate"
          Effect = "Allow"
          # Cloud Map private namespaces create a Route 53 zone; CreateHostedZone has no resource-level permission.
          Action   = ["route53:CreateHostedZone"]
          Resource = "*"
        },
        {
          Sid    = "HostedZoneManage"
          Effect = "Allow"
          Action = [
            "route53:AssociateVPCWithHostedZone",
            "route53:ChangeResourceRecordSets",
            "route53:ChangeTagsForResource",
            "route53:DeleteHostedZone",
            "route53:DisassociateVPCFromHostedZone",
          ]
          Resource = ["arn:${local.partition}:route53:::hostedzone/*"]
        },
        local.managed_secret_value_statement,
      ],
    )

    network-edge = [
      {
        Sid    = "VpcNetworking"
        Effect = "Allow"
        Action = [
          "ec2:AllocateAddress",
          "ec2:AssociateAddress",
          "ec2:AssociateRouteTable",
          "ec2:AttachInternetGateway",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:CreateInternetGateway",
          "ec2:CreateNatGateway",
          "ec2:CreateRoute",
          "ec2:CreateRouteTable",
          "ec2:CreateSecurityGroup",
          "ec2:CreateSubnet",
          "ec2:CreateTags",
          "ec2:CreateVpc",
          "ec2:CreateVpcEndpoint",
          "ec2:DeleteInternetGateway",
          "ec2:DeleteNatGateway",
          "ec2:DeleteNetworkInterface",
          "ec2:DeleteRoute",
          "ec2:DeleteRouteTable",
          "ec2:DeleteSecurityGroup",
          "ec2:DeleteSubnet",
          "ec2:DeleteTags",
          "ec2:DeleteVpc",
          "ec2:DeleteVpcEndpoints",
          "ec2:DetachInternetGateway",
          "ec2:DisassociateAddress",
          "ec2:DisassociateRouteTable",
          "ec2:ModifySecurityGroupRules",
          "ec2:ModifySubnetAttribute",
          "ec2:ModifyVpcAttribute",
          "ec2:ModifyVpcEndpoint",
          "ec2:ReleaseAddress",
          "ec2:ReplaceRoute",
          "ec2:ReplaceRouteTableAssociation",
          "ec2:RevokeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
          "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
        ]
        # EC2 ids are random, so the account and region are the narrowest scope; AWS prefix lists are owned by "aws".
        Resource  = ["${local.arn.ec2}:*", "arn:${local.partition}:ec2:${local.region}:aws:prefix-list/*"]
        Condition = local.in_region
      },
      {
        Sid    = "LoadBalancers"
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:AddTags",
          "elasticloadbalancing:CreateListener",
          "elasticloadbalancing:CreateLoadBalancer",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:CreateTargetGroup",
          "elasticloadbalancing:DeleteListener",
          "elasticloadbalancing:DeleteLoadBalancer",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:ModifyListener",
          "elasticloadbalancing:ModifyListenerAttributes",
          "elasticloadbalancing:ModifyLoadBalancerAttributes",
          "elasticloadbalancing:ModifyRule",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          "elasticloadbalancing:RemoveTags",
          "elasticloadbalancing:SetRulePriorities",
          "elasticloadbalancing:SetSecurityGroups",
          "elasticloadbalancing:SetSubnets",
        ]
        Resource = [
          "${local.arn.elb}:loadbalancer/app/${local.p}-*/*",
          "${local.arn.elb}:listener/app/${local.p}-*/*",
          "${local.arn.elb}:listener-rule/app/${local.p}-*/*",
          "${local.arn.elb}:targetgroup/${local.p}-*/*",
        ]
        Condition = local.in_region
      },
      {
        Sid    = "CloudMap"
        Effect = "Allow"
        Action = [
          "servicediscovery:CreateService",
          "servicediscovery:DeleteNamespace",
          "servicediscovery:DeleteService",
          "servicediscovery:TagResource",
          "servicediscovery:UntagResource",
          "servicediscovery:UpdatePrivateDnsNamespace",
          "servicediscovery:UpdateService",
        ]
        Resource  = ["${local.arn.sd}:namespace/*", "${local.arn.sd}:service/*"]
        Condition = local.in_region
      },
      {
        Sid    = "CloudFront"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateCachePolicy",
          "cloudfront:CreateDistribution",
          "cloudfront:CreateDistributionWithTags",
          "cloudfront:CreateFunction",
          "cloudfront:CreateOriginRequestPolicy",
          "cloudfront:CreateResponseHeadersPolicy",
          "cloudfront:CreateVpcOrigin",
          "cloudfront:DeleteCachePolicy",
          "cloudfront:DeleteDistribution",
          "cloudfront:DeleteFunction",
          "cloudfront:DeleteOriginRequestPolicy",
          "cloudfront:DeleteResponseHeadersPolicy",
          "cloudfront:DeleteVpcOrigin",
          "cloudfront:PublishFunction",
          "cloudfront:TagResource",
          "cloudfront:UntagResource",
          "cloudfront:UpdateCachePolicy",
          "cloudfront:UpdateDistribution",
          "cloudfront:UpdateFunction",
          "cloudfront:UpdateOriginRequestPolicy",
          "cloudfront:UpdateResponseHeadersPolicy",
          "cloudfront:UpdateVpcOrigin",
        ]
        Resource = [
          "${local.arn.cf}:cache-policy/*",
          "${local.arn.cf}:distribution/*",
          "${local.arn.cf}:function/${local.p}-*",
          "${local.arn.cf}:origin-request-policy/*",
          "${local.arn.cf}:response-headers-policy/*",
          "${local.arn.cf}:vpcorigin/*",
        ]
      },
      {
        Sid    = "WafForCloudFront"
        Effect = "Allow"
        Action = [
          "wafv2:CreateWebACL",
          "wafv2:DeleteWebACL",
          "wafv2:TagResource",
          "wafv2:UntagResource",
          "wafv2:UpdateWebACL",
        ]
        Resource = [
          "${local.arn.waf}:global/webacl/${local.p}-*/*",
          "${local.arn.waf}:global/managedruleset/*/*",
        ]
        Condition = local.in_edge_region
      },
    ]

    compute = [
      {
        Sid    = "EcrRepositories"
        Effect = "Allow"
        Action = [
          "ecr:BatchGetImage",
          "ecr:CreateRepository",
          "ecr:DeleteLifecyclePolicy",
          "ecr:DeleteRepository",
          "ecr:DeleteRepositoryPolicy",
          "ecr:GetDownloadUrlForLayer",
          "ecr:PutImageScanningConfiguration",
          "ecr:PutImageTagMutability",
          "ecr:PutLifecyclePolicy",
          "ecr:SetRepositoryPolicy",
          "ecr:TagResource",
          "ecr:UntagResource",
        ]
        Resource  = ["${local.arn.ecr}:repository/${local.p}-*"]
        Condition = local.in_region
      },
      {
        Sid    = "Ecs"
        Effect = "Allow"
        Action = [
          "ecs:CreateCluster",
          "ecs:CreateService",
          "ecs:DeleteCluster",
          "ecs:DeleteService",
          "ecs:DeleteTaskDefinitions",
          "ecs:PutClusterCapacityProviders",
          "ecs:TagResource",
          "ecs:UntagResource",
          "ecs:UpdateCluster",
          "ecs:UpdateClusterSettings",
          "ecs:UpdateService",
        ]
        Resource = [
          "${local.arn.ecs}:cluster/${local.p}-*",
          "${local.arn.ecs}:service/${local.p}-*/*",
          "${local.arn.ecs}:task-definition/${local.p}-*:*",
        ]
        Condition = local.in_region
      },
      {
        Sid    = "EcsAutoscaling"
        Effect = "Allow"
        Action = [
          "application-autoscaling:DeleteScalingPolicy",
          "application-autoscaling:DeregisterScalableTarget",
          "application-autoscaling:PutScalingPolicy",
          "application-autoscaling:RegisterScalableTarget",
          "application-autoscaling:TagResource",
          "application-autoscaling:UntagResource",
        ]
        Resource  = ["${local.arn.aas}:scalable-target/*"]
        Condition = local.in_region
      },
      {
        Sid    = "LambdaFunctions"
        Effect = "Allow"
        Action = [
          "lambda:AddPermission",
          "lambda:CreateAlias",
          "lambda:CreateFunction",
          "lambda:DeleteAlias",
          "lambda:DeleteFunction",
          "lambda:DeleteFunctionEventInvokeConfig",
          "lambda:PublishVersion",
          "lambda:PutFunctionEventInvokeConfig",
          "lambda:RemovePermission",
          "lambda:TagResource",
          "lambda:UntagResource",
          "lambda:UpdateAlias",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:UpdateFunctionEventInvokeConfig",
        ]
        Resource  = ["${local.arn.lambda}:function:${local.p}-*"]
        Condition = local.in_region
      },
      {
        Sid    = "LambdaEventSourceMappings"
        Effect = "Allow"
        Action = [
          "lambda:DeleteEventSourceMapping",
          "lambda:UpdateEventSourceMapping",
        ]
        Resource  = ["${local.arn.lambda}:event-source-mapping:*"]
        Condition = { ArnLike = { "lambda:FunctionArn" = "${local.arn.lambda}:function:${local.p}-*" } }
      },
      {
        Sid    = "LambdaEventSourceMappingTags"
        Effect = "Allow"
        # Tag requests carry no lambda:FunctionArn, so tag-on-create cannot be scoped by function.
        Action    = ["lambda:TagResource", "lambda:UntagResource"]
        Resource  = ["${local.arn.lambda}:event-source-mapping:*"]
        Condition = local.in_region
      },
      {
        Sid    = "EventBridgeRules"
        Effect = "Allow"
        Action = [
          "events:DeleteRule",
          "events:DisableRule",
          "events:EnableRule",
          "events:PutRule",
          "events:PutTargets",
          "events:RemoveTargets",
          "events:TagResource",
          "events:UntagResource",
        ]
        Resource  = ["${local.arn.events}:rule/${local.p}-*"]
        Condition = local.in_region
      },
      {
        Sid    = "Schedules"
        Effect = "Allow"
        Action = [
          "scheduler:CreateSchedule",
          "scheduler:CreateScheduleGroup",
          "scheduler:DeleteSchedule",
          "scheduler:DeleteScheduleGroup",
          "scheduler:TagResource",
          "scheduler:UntagResource",
          "scheduler:UpdateSchedule",
        ]
        Resource = [
          "${local.arn.scheduler}:schedule/default/${local.p}-*",
          "${local.arn.scheduler}:schedule/${local.p}-*/*",
          "${local.arn.scheduler}:schedule-group/${local.p}-*",
        ]
        Condition = local.in_region
      },
      {
        Sid    = "LogGroups"
        Effect = "Allow"
        Action = [
          "logs:AssociateKmsKey",
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:DeleteMetricFilter",
          "logs:DeleteRetentionPolicy",
          "logs:DisassociateKmsKey",
          "logs:PutMetricFilter",
          "logs:PutRetentionPolicy",
          "logs:TagLogGroup",
          "logs:TagResource",
          "logs:UntagLogGroup",
          "logs:UntagResource",
        ]
        Resource = [
          "${local.arn.logs}:log-group:/${local.p}/*",
          "${local.arn.logs}:log-group:/aws/lambda/${local.p}-*",
          "${local.arn.logs}:log-group:/aws/rds/cluster/${local.p}-*",
        ]
        Condition = local.in_region
      },
    ]

    data = [
      {
        Sid    = "Buckets"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:DeleteBucketPolicy",
          "s3:PutBucketCORS",
          "s3:PutBucketNotification",
          "s3:PutBucketOwnershipControls",
          "s3:PutBucketPolicy",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketTagging",
          "s3:PutBucketVersioning",
          "s3:PutEncryptionConfiguration",
          "s3:PutLifecycleConfiguration",
        ]
        Resource  = ["${local.arn.s3}*"]
        Condition = local.in_region
      },
      {
        Sid    = "Aurora"
        Effect = "Allow"
        Action = [
          "rds:AddTagsToResource",
          "rds:CreateDBCluster",
          "rds:CreateDBClusterParameterGroup",
          "rds:CreateDBClusterSnapshot",
          "rds:CreateDBInstance",
          "rds:CreateDBParameterGroup",
          "rds:CreateDBSubnetGroup",
          "rds:DeleteDBCluster",
          "rds:DeleteDBClusterParameterGroup",
          "rds:DeleteDBInstance",
          "rds:DeleteDBParameterGroup",
          "rds:DeleteDBSubnetGroup",
          "rds:ModifyDBCluster",
          "rds:ModifyDBClusterParameterGroup",
          "rds:ModifyDBInstance",
          "rds:ModifyDBParameterGroup",
          "rds:ModifyDBSubnetGroup",
          "rds:RemoveTagsFromResource",
        ]
        Resource = [
          "${local.arn.rds}:cluster:${local.p}-*",
          "${local.arn.rds}:cluster-pg:${local.p}-*",
          "${local.arn.rds}:cluster-pg:default.*",
          "${local.arn.rds}:cluster-snapshot:${local.p}-*",
          "${local.arn.rds}:db:${local.p}-*",
          "${local.arn.rds}:og:default*",
          "${local.arn.rds}:pg:${local.p}-*",
          "${local.arn.rds}:pg:default.*",
          "${local.arn.rds}:subgrp:${local.p}-*",
        ]
        Condition = local.in_region
      },
      {
        Sid    = "RdsManagedMasterSecret"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:RotateSecret",
          "secretsmanager:TagResource",
        ]
        Resource  = ["${local.arn.secrets}:secret:rds!*"]
        Condition = local.in_region
      },
      {
        Sid    = "Secrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteResourcePolicy",
          "secretsmanager:DeleteSecret",
          "secretsmanager:PutResourcePolicy",
          "secretsmanager:PutSecretValue",
          "secretsmanager:RestoreSecret",
          "secretsmanager:TagResource",
          "secretsmanager:UntagResource",
          "secretsmanager:UpdateSecret",
        ]
        Resource  = ["${local.arn.secrets}:secret:${local.p}/*"]
        Condition = local.in_region
      },
      {
        Sid    = "Queues"
        Effect = "Allow"
        Action = [
          "sqs:CreateQueue",
          "sqs:DeleteQueue",
          "sqs:SetQueueAttributes",
          "sqs:TagQueue",
          "sqs:UntagQueue",
        ]
        Resource  = ["${local.arn.sqs}:${local.p}-*"]
        Condition = local.in_region
      },
      {
        Sid    = "Topics"
        Effect = "Allow"
        Action = [
          "sns:CreateTopic",
          "sns:DeleteTopic",
          "sns:SetTopicAttributes",
          "sns:Subscribe",
          "sns:TagResource",
          "sns:Unsubscribe",
          "sns:UntagResource",
        ]
        Resource  = ["${local.arn.sns}:${local.p}-*"]
        Condition = local.in_region
      },
      {
        Sid    = "AlarmsAndDashboards"
        Effect = "Allow"
        Action = [
          "cloudwatch:DeleteAlarms",
          "cloudwatch:DeleteDashboards",
          "cloudwatch:PutDashboard",
          "cloudwatch:PutMetricAlarm",
          "cloudwatch:TagResource",
          "cloudwatch:UntagResource",
        ]
        Resource  = ["${local.arn.cw}:alarm:${local.p}-*", "${local.arn.cw_global}:dashboard/${local.p}-*"]
        Condition = local.in_region
      },
      {
        Sid    = "Cognito"
        Effect = "Allow"
        Action = [
          "cognito-idp:CreateResourceServer",
          "cognito-idp:CreateUserPoolClient",
          "cognito-idp:CreateUserPoolDomain",
          "cognito-idp:DeleteResourceServer",
          "cognito-idp:DeleteUserPool",
          "cognito-idp:DeleteUserPoolClient",
          "cognito-idp:DeleteUserPoolDomain",
          "cognito-idp:SetUserPoolMfaConfig",
          "cognito-idp:TagResource",
          "cognito-idp:UntagResource",
          "cognito-idp:UpdateResourceServer",
          "cognito-idp:UpdateUserPool",
          "cognito-idp:UpdateUserPoolClient",
          "cognito-idp:UpdateUserPoolDomain",
        ]
        Resource  = ["${local.arn.cognito}:userpool/*"]
        Condition = local.in_region
      },
      {
        Sid    = "Ses"
        Effect = "Allow"
        Action = [
          "ses:CreateConfigurationSet",
          "ses:CreateConfigurationSetEventDestination",
          "ses:CreateEmailIdentity",
          "ses:DeleteConfigurationSet",
          "ses:DeleteConfigurationSetEventDestination",
          "ses:DeleteEmailIdentity",
          "ses:PutConfigurationSetDeliveryOptions",
          "ses:PutConfigurationSetReputationOptions",
          "ses:PutConfigurationSetSendingOptions",
          "ses:PutConfigurationSetSuppressionOptions",
          "ses:PutConfigurationSetTrackingOptions",
          "ses:PutEmailIdentityConfigurationSetAttributes",
          "ses:PutEmailIdentityFeedbackAttributes",
          "ses:TagResource",
          "ses:UntagResource",
          "ses:UpdateConfigurationSetEventDestination",
        ]
        # Email identities are named by the address, not the prefix.
        Resource  = ["${local.arn.ses}:identity/*", "${local.arn.ses}:configuration-set/${local.p}-*"]
        Condition = local.in_region
      },
      {
        Sid    = "MalwareProtection"
        Effect = "Allow"
        Action = [
          "guardduty:CreateMalwareProtectionPlan",
          "guardduty:DeleteMalwareProtectionPlan",
          "guardduty:TagResource",
          "guardduty:UntagResource",
          "guardduty:UpdateMalwareProtectionPlan",
        ]
        Resource  = ["${local.arn.guardduty}:malware-protection-plan/*"]
        Condition = local.in_region
      },
      {
        Sid      = "Budgets"
        Effect   = "Allow"
        Action   = ["budgets:ModifyBudget", "budgets:TagResource", "budgets:UntagResource"]
        Resource = ["${local.arn.budgets}:budget/${local.p}-*"]
      },
    ]
  }
}
