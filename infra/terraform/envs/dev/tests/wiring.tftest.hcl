mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-north-1", name = "eu-north-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-north-1a", "eu-north-1b", "eu-north-1c"] }
  }
  mock_data "aws_security_group" {
    defaults = { id = "sg-0cccccccccccccc0f", name = "CloudFront-VPCOrigins-Service-SG", vpc_id = "vpc-0123456789abcdef0" }
  }
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-0123456789abcdef0" }
  }

  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/cd/cd-mock-role" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:/cd/dev/mock" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:eu-north-1:123456789012:repository/cd-mock"
      repository_url = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cd-dev-tools"
    }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:eu-north-1:123456789012:cluster/cd-cluster" }
  }
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = {
      arn = "arn:aws:servicediscovery:eu-north-1:123456789012:namespace/ns-abcdefghijklmnop"
      id  = "ns-abcdefghijklmnop"
    }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:eu-north-1:123456789012:service/srv-abc" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:eu-north-1:123456789012:task-definition/cd-mock:1" }
  }
  mock_resource "aws_ecs_service" {
    defaults = { id = "arn:aws:ecs:eu-north-1:123456789012:service/cd-cluster/cd-mock" }
  }
  mock_resource "aws_rds_cluster" {
    defaults = {
      arn                 = "arn:aws:rds:eu-north-1:123456789012:cluster:cd-aurora"
      endpoint            = "cd-aurora.cluster-abc123.eu-north-1.rds.amazonaws.com"
      cluster_resource_id = "cluster-ABCDEFGHIJKLMNOP"
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:rds!cluster-abc-AbCdEf"
        kms_key_id    = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
        secret_status = "active"
      }]
    }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cd/dev/mock-AbCdEf" }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id  = "eu-north-1_TestPool1"
      arn = "arn:aws:cognito-idp:eu-north-1:123456789012:userpool/eu-north-1_TestPool1"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:eu-north-1:123456789012:cd-mock"
      url = "https://sqs.eu-north-1.amazonaws.com/123456789012/cd-mock"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::cd-dev-mock-123456789012", id = "cd-dev-mock-123456789012" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:eu-north-1:123456789012:rule/cd-evidence-scan-result" }
  }
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:eu-north-1:123456789012:loadbalancer/app/cd-alb/0123456789abcdef"
      arn_suffix = "app/cd-alb/0123456789abcdef"
      dns_name   = "internal-cd-alb-123456789.eu-north-1.elb.amazonaws.com"
    }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-north-1:123456789012:listener/app/cd-alb/0123456789abcdef/0000000000000001" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:eu-north-1:123456789012:targetgroup/cd-mock/0000000000000000"
      arn_suffix = "targetgroup/cd-mock/0000000000000000"
    }
  }
  mock_resource "aws_cloudfront_vpc_origin" {
    defaults = {
      id  = "vo_0123456789abcdefABCDEF"
      arn = "arn:aws:cloudfront::123456789012:vpcorigin/vo_0123456789abcdefABCDEF"
    }
  }
  mock_resource "aws_cloudfront_function" {
    defaults = { arn = "arn:aws:cloudfront::123456789012:function/cd-strip-api" }
  }
  mock_resource "aws_cloudfront_origin_request_policy" {
    defaults = { id = "11111111-2222-3333-4444-555555555555" }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      id          = "E2EXAMPLE12345"
      arn         = "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE12345"
      domain_name = "d111111abcdef8.cloudfront.net"
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cd-mock", version = "1" }
  }
  mock_resource "aws_lambda_alias" {
    defaults = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cd-evidence-intake:live" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-north-1:123456789012:cd-alarms" }
  }
}

mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan

  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/cd-edge/00000000-0000-0000-0000-000000000000" }
  }
}

mock_provider "random" {}

override_resource {
  target          = module.security.aws_kms_key.this["evidence"]
  override_during = plan
  values          = { arn = "arn:aws:kms:eu-north-1:123456789012:key/11111111-1111-1111-1111-111111111111" }
}

# ci-roles finds the net-probe pair by role name, so these two need their real names.
override_resource {
  target          = module.dev_tools.aws_iam_role.task["net-probe"]
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/cd/cd-net-probe-task" }
}

override_resource {
  target          = module.dev_tools.aws_iam_role.execution["net-probe"]
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/cd/cd-net-probe-exec" }
}

variables {
  # dev.tfvars keeps the PLACEHOLDER repo, which the variable validation rejects by design.
  github_repo    = "example-org/card-dispute"
  aurora_min_acu = 0.5
  aurora_max_acu = 2
  budget_usd     = 200
  alert_email    = "alerts@example.com"
  ses_sender     = "sender@example.com"
}

run "phase_a_no_functions" {
  command = plan

  assert {
    condition     = alltrue([for k in local.lambda_keys : module.lambda[k].function_name == null && module.lambda[k].alias_arn == null])
    error_message = "Phase A must create no Lambda function or alias."
  }

  assert {
    condition     = alltrue([for k in local.lambda_keys : module.lambda[k].role_arn != null])
    error_message = "Every Lambda role must exist in phase A (ADR-066)."
  }

  assert {
    condition     = module.lambda["retention-sweeper"].scheduler_role_arn != null
    error_message = "The sweeper Scheduler role must exist in phase A (messaging allow-list)."
  }

  assert {
    condition     = local.service_desired_count == 0 && !var.enable_service_autoscaling && length(module.service) == 5
    error_message = "All five services start at desired_count 0 with autoscaling off."
  }

  assert {
    condition = alltrue([
      for a in flatten([for s in concat(flatten(values(local.task_role_statements)), flatten(values(local.lambda_policy_statements))) : s.Action]) :
      !can(regex("^s3:.*Tagging", a))
    ])
    error_message = "No workload policy may hold an s3 tagging action."
  }

  assert {
    condition = (
      !contains(flatten([for s in local.task_role_statements["disputes"] : s.Action]), "s3:GetObject")
      && toset(flatten([for s in local.task_role_statements["disputes"] : s.Resource if contains(s.Action, "s3:PutObject")])) == toset(["${module.evidence_buckets.quarantine_bucket_arn}/intake/*"])
    )
    error_message = "disputes may only PutObject on quarantine intake/* and never GetObject."
  }

  assert {
    condition = alltrue([
      for s in local.task_role_statements["disputes"] : s.Action == ["kms:GenerateDataKey"]
      if contains(s.Resource, module.security.kms_key_arns["evidence"])
    ])
    error_message = "disputes may only GenerateDataKey on the evidence key."
  }

  assert {
    condition = alltrue([
      for s in local.lambda_policy_statements["dispute-notifier"] :
      s.Condition.StringEquals["ses:FromAddress"] == [var.ses_sender]
      if contains(s.Action, "ses:SendEmail")
    ]) && length([for s in local.lambda_policy_statements["dispute-notifier"] : s if contains(s.Action, "ses:SendEmail")]) == 1
    error_message = "notifier ses:SendEmail must carry the ses:FromAddress condition."
  }

  assert {
    condition = toset(flatten([
      for s in local.lambda_policy_statements["retention-sweeper"] : s.Resource if contains(s.Action, "secretsmanager:GetSecretValue")
    ])) == toset([module.aurora.role_secret_arns["disputes_retention"]])
    error_message = "The sweeper reads only its own disputes_retention secret."
  }

  assert {
    condition = length([
      for s in local.lambda_policy_statements["evidence-intake"] : s
      if contains(s.Action, "s3:ListBucket") && s.Resource == [module.evidence_buckets.quarantine_bucket_arn]
    ]) == 1
    error_message = "intake needs s3:ListBucket on the quarantine bucket so a missing object is 404, not 403."
  }
}

run "phase_b_functions" {
  command = plan

  variables {
    lambda_image_uris = {
      evidence-intake   = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cd-lambda-evidence-intake:0123abc"
      dispute-notifier  = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cd-lambda-dispute-notifier:0123abc"
      retention-sweeper = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cd-lambda-retention-sweeper:0123abc"
    }
  }

  assert {
    condition     = alltrue([for k in local.lambda_keys : module.lambda[k].function_name == "cd-${k}" && module.lambda[k].alias_arn != null])
    error_message = "Phase B creates every function with its live alias."
  }

  assert {
    condition     = output.lambda_function_names["dispute-notifier"] == "cd-dispute-notifier"
    error_message = "Root output must expose the created function names."
  }
}

run "public_alb_fallback" {
  command = plan

  variables {
    edge_origin_mode = "public_alb"
  }

  assert {
    condition     = local.lambda_peer_url["disputes"] == "http://disputes.cd.internal:8081" && local.lambda_peer_url["users"] == "http://users.cd.internal:8081"
    error_message = "In public_alb, Lambdas reach users and disputes by Cloud Map DNS."
  }

  assert {
    condition     = !contains(keys(local.target_groups["disputes"]), "8081") && !contains(keys(local.target_groups["users"]), "8081")
    error_message = "public_alb has no :8081 target groups."
  }
}
