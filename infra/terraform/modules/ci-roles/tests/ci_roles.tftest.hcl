mock_provider "aws" {
  override_during = plan

  mock_data "aws_region" {
    defaults = { region = "af-south-1", name = "af-south-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/cd/cd-gha-mock" }
  }
}

variables {
  name_prefix              = "cd"
  permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cd-workload-boundary"
  iam_path                 = "/cd/"
  github_repo              = "acme/card-dispute"
  github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  ecr_repository_arns = {
    svc-auth                 = "arn:aws:ecr:af-south-1:123456789012:repository/cd-svc-auth"
    svc-users                = "arn:aws:ecr:af-south-1:123456789012:repository/cd-svc-users"
    svc-transactions         = "arn:aws:ecr:af-south-1:123456789012:repository/cd-svc-transactions"
    svc-disputes             = "arn:aws:ecr:af-south-1:123456789012:repository/cd-svc-disputes"
    web                      = "arn:aws:ecr:af-south-1:123456789012:repository/cd-web"
    lambda-evidence-intake   = "arn:aws:ecr:af-south-1:123456789012:repository/cd-lambda-evidence-intake"
    lambda-dispute-notifier  = "arn:aws:ecr:af-south-1:123456789012:repository/cd-lambda-dispute-notifier"
    lambda-retention-sweeper = "arn:aws:ecr:af-south-1:123456789012:repository/cd-lambda-retention-sweeper"
    dev-tools                = "arn:aws:ecr:af-south-1:123456789012:repository/cd-dev-tools"
  }
  ecs_cluster_arn = "arn:aws:ecs:af-south-1:123456789012:cluster/cd-cluster"
  ecs_deployables = {
    auth = {
      service_arn              = "arn:aws:ecs:af-south-1:123456789012:service/cd-cluster/cd-auth"
      task_definition_families = ["cd-auth", "cd-auth-migrate"]
      pass_role_arns           = ["arn:aws:iam::123456789012:role/cd/cd-auth-task", "arn:aws:iam::123456789012:role/cd/cd-auth-exec"]
    }
    users = {
      service_arn              = "arn:aws:ecs:af-south-1:123456789012:service/cd-cluster/cd-users"
      task_definition_families = ["cd-users", "cd-users-migrate"]
      pass_role_arns           = ["arn:aws:iam::123456789012:role/cd/cd-users-task", "arn:aws:iam::123456789012:role/cd/cd-users-exec"]
    }
    transactions = {
      service_arn              = "arn:aws:ecs:af-south-1:123456789012:service/cd-cluster/cd-transactions"
      task_definition_families = ["cd-transactions", "cd-transactions-migrate"]
      pass_role_arns           = ["arn:aws:iam::123456789012:role/cd/cd-transactions-task", "arn:aws:iam::123456789012:role/cd/cd-transactions-exec"]
    }
    disputes = {
      service_arn              = "arn:aws:ecs:af-south-1:123456789012:service/cd-cluster/cd-disputes"
      task_definition_families = ["cd-disputes", "cd-disputes-migrate"]
      pass_role_arns           = ["arn:aws:iam::123456789012:role/cd/cd-disputes-task", "arn:aws:iam::123456789012:role/cd/cd-disputes-exec"]
    }
    web = {
      service_arn              = "arn:aws:ecs:af-south-1:123456789012:service/cd-cluster/cd-web"
      task_definition_families = ["cd-web"]
      pass_role_arns           = ["arn:aws:iam::123456789012:role/cd/cd-web-task", "arn:aws:iam::123456789012:role/cd/cd-web-exec"]
    }
  }
  lambda_function_names = {
    evidence-intake   = "cd-evidence-intake"
    dispute-notifier  = "cd-dispute-notifier"
    retention-sweeper = "cd-retention-sweeper"
  }
  dev_tools = {
    task_definition_families = ["cd-db-bootstrap", "cd-dev-seed", "cd-net-probe"]
    pass_role_arns = [
      "arn:aws:iam::123456789012:role/cd/cd-db-bootstrap-task", "arn:aws:iam::123456789012:role/cd/cd-db-bootstrap-exec",
      "arn:aws:iam::123456789012:role/cd/cd-dev-seed-task", "arn:aws:iam::123456789012:role/cd/cd-dev-seed-exec",
      "arn:aws:iam::123456789012:role/cd/cd-net-probe-task", "arn:aws:iam::123456789012:role/cd/cd-net-probe-exec",
    ]
  }
  cognito_user_pool_arn        = "arn:aws:cognito-idp:af-south-1:123456789012:userpool/af-south-1_AbCdEf123"
  seed_user_secret_name_prefix = "cd/dev/seed-users/"
  ses_events_queue_arn         = "arn:aws:sqs:af-south-1:123456789012:cd-ses-events"
  evidence_bucket_arns         = ["arn:aws:s3:::cd-dev-quarantine-123456789012", "arn:aws:s3:::cd-dev-evidence-123456789012"]
  data_kms_key_arn             = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
}

run "roles_match_the_contract" {
  command = plan

  assert {
    condition = toset(keys(output.role_arns)) == toset([
      "publish-svc-auth", "publish-svc-users", "publish-svc-transactions", "publish-svc-disputes", "publish-web",
      "publish-lambda-evidence-intake", "publish-lambda-dispute-notifier", "publish-lambda-retention-sweeper", "publish-dev-tools",
      "deploy-auth", "deploy-users", "deploy-transactions", "deploy-disputes", "deploy-web",
      "deploy-lambda-evidence-intake", "deploy-lambda-dispute-notifier", "deploy-lambda-retention-sweeper",
      "run-tools", "e2e",
    ])
    error_message = "role_arns must have exactly the 19 contract keys."
  }

  assert {
    condition     = alltrue([for k, r in aws_iam_role.this : r.name == "cd-gha-${k}" && r.path == "/cd/" && r.permissions_boundary == "arn:aws:iam::123456789012:policy/cd-workload-boundary" && r.max_session_duration == 3600])
    error_message = "Every role must be cd-gha-<key> under /cd/ with cd-workload-boundary and a 1 h max session."
  }
}

run "trust_pins_audience_and_exact_subject" {
  command = plan

  assert {
    condition = alltrue([
      for k, r in aws_iam_role.this :
      length(jsondecode(r.assume_role_policy).Statement) == 1
      && jsondecode(r.assume_role_policy).Statement[0].Effect == "Allow"
      && jsondecode(r.assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity"
      && jsondecode(r.assume_role_policy).Statement[0].Principal == { Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
      && jsondecode(r.assume_role_policy).Statement[0].Condition == {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = startswith(k, "publish-") ? "repo:acme/card-dispute:ref:refs/heads/main" : "repo:acme/card-dispute:environment:dev"
        }
      }
    ])
    error_message = "Publish roles must trust only sub ref:refs/heads/main; deploy, run-tools and e2e only environment:dev; aud sts.amazonaws.com; StringEquals only."
  }

  assert {
    condition     = alltrue([for r in aws_iam_role.this : !strcontains(r.assume_role_policy, "*") && !strcontains(r.assume_role_policy, "StringLike")])
    error_message = "No trust policy may contain a wildcard or StringLike."
  }
}

run "no_role_reaches_another_deployable" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for k, pol in aws_iam_role_policy.this : [
        for s in jsondecode(pol.policy).Statement : [
          for res in s.Resource : [
            for unit, markers in {
              auth              = ["cd-auth", "/ecs/auth", "cd-svc-auth"]
              users             = ["cd-users", "/ecs/users", "cd-svc-users"]
              transactions      = ["cd-transactions", "/ecs/transactions", "cd-svc-transactions"]
              disputes          = ["cd-disputes", "/ecs/disputes", "cd-svc-disputes"]
              web               = ["cd-web", "/ecs/web"]
              evidence-intake   = ["cd-evidence-intake", "cd-lambda-evidence-intake"]
              dispute-notifier  = ["cd-dispute-notifier", "cd-lambda-dispute-notifier"]
              retention-sweeper = ["cd-retention-sweeper", "cd-lambda-retention-sweeper"]
              tools             = ["cd-db-bootstrap", "cd-dev-seed", "cd-net-probe", "cd-dev-tools", "/tools/"]
              } : [
              for m in markers : !strcontains(res, m)
            ] if unit != replace(replace(replace(replace(k, "publish-svc-", ""), "publish-lambda-", ""), "deploy-lambda-", ""), "/^(deploy-|publish-)/", "") && !(unit == "tools" && contains(["publish-dev-tools", "run-tools"], k))
          ]
        ]
      ] if k != "e2e"
    ]))
    error_message = "A publish, deploy or run-tools policy names a resource of another deployable."
  }

  assert {
    condition     = alltrue([for k in ["deploy-auth", "deploy-users", "deploy-transactions", "deploy-disputes", "deploy-web"] : contains(one([for s in jsondecode(aws_iam_role_policy.this[k].policy).Statement : s if s.Sid == "UpdateOwnService"]).Resource, "arn:aws:ecs:af-south-1:123456789012:service/cd-cluster/cd-${trimprefix(k, "deploy-")}")])
    error_message = "Each ECS deploy role must update exactly its own service."
  }

  assert {
    condition = alltrue(flatten([
      for k, pol in aws_iam_role_policy.this : [
        for s in jsondecode(pol.policy).Statement :
        s.Condition == { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:af-south-1:123456789012:cluster/cd-cluster" } }
        if length(setintersection(s.Action, ["ecs:RunTask", "ecs:DescribeTasks", "ecs:UpdateService", "ecs:DescribeServices"])) > 0
      ]
    ]))
    error_message = "Every RunTask, DescribeTasks, UpdateService and DescribeServices statement must carry the ecs:cluster condition."
  }

  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.this["e2e"].policy).Statement : s.Resource if s.Sid == "RunNetProbe"]) == ["arn:aws:ecs:af-south-1:123456789012:task-definition/cd-net-probe:*"]
    error_message = "e2e may run only the net-probe task family."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.this["e2e"].policy).Statement : [
        for a in s.Action : !startswith(a, "ecr:") && !startswith(a, "lambda:") && !contains(["ecs:UpdateService", "ecs:RegisterTaskDefinition", "sqs:SendMessage", "s3:PutObject", "s3:DeleteObject"], a)
      ]
    ]))
    error_message = "e2e must not deploy, publish or write to queues and buckets."
  }
}

run "pass_role_is_limited_to_own_roles_for_ecs" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for k, pol in aws_iam_role_policy.this : [
        for s in jsondecode(pol.policy).Statement : [
          for a in s.Action : !startswith(a, "iam:") || (
            a == "iam:PassRole" && length(s.Action) == 1
            && lookup(s, "Condition", null) == { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
          )
        ]
      ]
    ]))
    error_message = "The only IAM action allowed is iam:PassRole, alone in its statement, with iam:PassedToService ecs-tasks.amazonaws.com."
  }

  assert {
    condition = alltrue([
      for s in ["auth", "users", "transactions", "disputes", "web"] :
      one([for st in jsondecode(aws_iam_role_policy.this["deploy-${s}"].policy).Statement : st.Resource if st.Action == ["iam:PassRole"]]) == ["arn:aws:iam::123456789012:role/cd/cd-${s}-task", "arn:aws:iam::123456789012:role/cd/cd-${s}-exec"]
    ])
    error_message = "Each ECS deploy role may pass only its own task and execution roles."
  }

  assert {
    condition     = one([for st in jsondecode(aws_iam_role_policy.this["e2e"].policy).Statement : st.Resource if st.Action == ["iam:PassRole"]]) == ["arn:aws:iam::123456789012:role/cd/cd-net-probe-task", "arn:aws:iam::123456789012:role/cd/cd-net-probe-exec"]
    error_message = "e2e may pass only the net-probe roles."
  }

  assert {
    condition     = alltrue([for k, pol in aws_iam_role_policy.this : !anytrue([for s in jsondecode(pol.policy).Statement : contains(s.Action, "iam:PassRole")]) if startswith(k, "publish-") || startswith(k, "deploy-lambda-")])
    error_message = "Publish and Lambda deploy roles must not pass any role."
  }
}

run "wildcards_only_where_documented" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for k, pol in aws_iam_role_policy.this : [
        for s in jsondecode(pol.policy).Statement : s.Resource == ["*"] && length(setsubtract(s.Action, lookup({
          publish     = ["ecr:GetAuthorizationToken"]
          deploy      = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "elasticloadbalancing:DescribeTargetHealth"]
          "run-tools" = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
          e2e = [
            "ec2:CreateNetworkInsightsPath", "ec2:StartNetworkInsightsAnalysis",
            "ec2:DescribeNetworkInsightsAnalyses", "ec2:DescribeNetworkInsightsPaths", "ec2:DescribeNetworkInterfaces",
            "ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs",
          ]
        }, startswith(k, "publish-") ? "publish" : startswith(k, "deploy-lambda-") ? "none" : startswith(k, "deploy-") ? "deploy" : k, []))) == 0
        if contains(s.Resource, "*")
      ]
    ]))
    error_message = "A Resource \"*\" appears outside the documented exceptions for that role kind, or is mixed with other resources."
  }

  assert {
    condition     = alltrue(flatten([for pol in aws_iam_role_policy.this : [for s in jsondecode(pol.policy).Statement : [for a in s.Action : !strcontains(a, "*")]]]))
    error_message = "No action may contain a wildcard."
  }

  assert {
    condition     = alltrue(flatten([for pol in aws_iam_role_policy.this : [for s in jsondecode(pol.policy).Statement : s.Effect == "Allow" && s.Sid != "" && length(s.Resource) > 0]]))
    error_message = "Every statement must be an Allow with a Sid and at least one resource."
  }

  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.this["e2e"].policy).Statement : s.Condition if s.Sid == "ReachabilityCleanupOwn"]) == { StringEquals = { "aws:ResourceTag/created-by" = "cd-gha-e2e" } }
    error_message = "e2e may delete only Network Insights resources it tagged."
  }
}

run "subject_wildcard_is_rejected" {
  command = plan

  variables {
    github_repo = "acme/*"
  }

  expect_failures = [var.github_repo]
}
