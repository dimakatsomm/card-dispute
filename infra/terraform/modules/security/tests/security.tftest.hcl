mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-north-1" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000" }
  }
}

variables {
  name_prefix       = "cd"
  vpc_id            = "vpc-0123456789abcdef0"
  s3_prefix_list_id = "pl-6da54004"
  edge_origin_mode  = "vpc_origin"
}

run "vpc_origin" {
  command = apply

  assert {
    condition     = toset(keys(output.security_group_ids)) == toset(["alb", "auth", "users", "transactions", "disputes", "web", "evidence-intake", "dispute-notifier", "retention-sweeper", "aurora", "dev-tools"])
    error_message = "security_group_ids must carry exactly the contract keys."
  }

  assert {
    condition     = toset(keys(output.kms_key_arns)) == toset(["data", "evidence"])
    error_message = "kms_key_arns must carry exactly data and evidence."
  }

  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.flow : r.cidr_ipv4 == null && r.cidr_ipv6 == null && r.prefix_list_id == null])
    error_message = "No ingress rule may use a CIDR or prefix list (0.0.0.0/0, ::/0 or otherwise)."
  }

  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.flow : r.referenced_security_group_id != null if r.from_port == 8081 || r.to_port == 8081])
    error_message = "Every :8081 ingress rule must reference a security group."
  }

  assert {
    condition = toset([
      for r in aws_vpc_security_group_ingress_rule.flow : r.referenced_security_group_id
      if r.security_group_id == aws_security_group.this["alb"].id && r.from_port == 8081
      ]) == toset([
      aws_security_group.this["evidence-intake"].id,
      aws_security_group.this["dispute-notifier"].id,
    ])
    error_message = "ALB :8081 sources must be exactly the evidence-intake and dispute-notifier SGs."
  }

  assert {
    condition     = length([for r in aws_vpc_security_group_ingress_rule.flow : r if r.security_group_id == aws_security_group.this["alb"].id && r.from_port != 8081]) == 0
    error_message = "The ALB :80 ingress rule belongs to edge, not security."
  }

  assert {
    condition = toset([
      for r in aws_vpc_security_group_ingress_rule.flow : r.referenced_security_group_id
      if r.security_group_id == aws_security_group.this["aurora"].id && r.from_port == 5432 && r.to_port == 5432
      ]) == toset([
      for k in ["auth", "users", "transactions", "disputes", "retention-sweeper", "dev-tools"] : aws_security_group.this[k].id
    ])
    error_message = "Aurora :5432 sources must be exactly the four backend services, retention-sweeper and dev-tools."
  }

  assert {
    condition = toset([
      for r in aws_vpc_security_group_ingress_rule.flow : r.referenced_security_group_id
      if r.security_group_id == aws_security_group.this["auth"].id
    ]) == toset([for k in ["users", "transactions", "disputes"] : aws_security_group.this[k].id])
    error_message = "auth :8081 must accept only users, transactions and disputes."
  }

  assert {
    condition = toset([
      for r in aws_vpc_security_group_ingress_rule.flow : "${r.referenced_security_group_id}:${r.from_port}"
      if r.security_group_id == aws_security_group.this["users"].id
      ]) == toset([
      "${aws_security_group.this["alb"].id}:8080",
      "${aws_security_group.this["alb"].id}:8081",
      "${aws_security_group.this["transactions"].id}:8081",
      "${aws_security_group.this["disputes"].id}:8081",
    ])
    error_message = "users ingress must be :8080 from alb and :8081 from alb, transactions, disputes."
  }

  assert {
    condition = toset([
      for r in aws_vpc_security_group_ingress_rule.flow : "${r.referenced_security_group_id}:${r.from_port}"
      if r.security_group_id == aws_security_group.this["disputes"].id
      ]) == toset([
      "${aws_security_group.this["alb"].id}:8080",
      "${aws_security_group.this["alb"].id}:8081",
      "${aws_security_group.this["transactions"].id}:8081",
    ])
    error_message = "disputes ingress must be :8080 from alb and :8081 from alb, transactions."
  }

  assert {
    condition = toset([
      for r in aws_vpc_security_group_ingress_rule.flow : "${r.referenced_security_group_id}:${r.from_port}"
      if r.security_group_id == aws_security_group.this["transactions"].id
      ]) == toset([
      "${aws_security_group.this["alb"].id}:8080",
      "${aws_security_group.this["disputes"].id}:8081",
    ])
    error_message = "transactions ingress must be :8080 from alb and :8081 from disputes."
  }

  assert {
    condition = length([
      for r in aws_vpc_security_group_ingress_rule.flow : r
      if contains([for k in ["evidence-intake", "dispute-notifier", "retention-sweeper", "dev-tools"] : aws_security_group.this[k].id], r.security_group_id)
    ]) == 0
    error_message = "Lambda and dev-tools SGs must have no ingress."
  }

  assert {
    condition = length(concat(
      [for r in aws_vpc_security_group_egress_rule.flow : r if r.security_group_id == aws_security_group.this["aurora"].id],
      [for r in aws_vpc_security_group_egress_rule.https_internet : r if r.security_group_id == aws_security_group.this["aurora"].id],
    )) == 0
    error_message = "Aurora must have no egress."
  }

  assert {
    condition = length([
      for r in aws_vpc_security_group_egress_rule.flow : r
      if r.security_group_id == aws_security_group.this["dev-tools"].id && r.referenced_security_group_id != aws_security_group.this["aurora"].id
    ]) == 0
    error_message = "dev-tools must reach no SG except aurora (net-probe proves the denials)."
  }

  assert {
    condition     = alltrue([for k in aws_kms_key.this : k.enable_key_rotation])
    error_message = "Rotation must be on for every key."
  }

  assert {
    condition     = aws_kms_alias.this["data"].name == "alias/cd-data" && aws_kms_alias.this["evidence"].name == "alias/cd-evidence"
    error_message = "Aliases must follow alias/<name_prefix>-<key>."
  }

  assert {
    condition = alltrue(flatten([
      for k in aws_kms_key.this : [
        for s in jsondecode(k.policy).Statement : [
          for a in s.Action : a != "kms:*" && !endswith(a, "*")
        ]
      ]
    ]))
    error_message = "Key policies must list explicit actions (no kms:* or wildcards)."
  }

  assert {
    condition = length([
      for s in jsondecode(aws_kms_key.this["evidence"].policy).Statement : s
      if s.Effect == "Allow" && contains(s.Action, "kms:GenerateDataKey")
      && try(s.Condition.ArnEquals["aws:PrincipalArn"], "") == "arn:aws:iam::123456789012:role/cd/cd-disputes-task"
    ]) == 1
    error_message = "The disputes task role must be allowed kms:GenerateDataKey on the evidence (quarantine) key."
  }

  assert {
    condition = length([
      for s in jsondecode(aws_kms_key.this["evidence"].policy).Statement : s
      if s.Effect == "Allow" && contains(s.Action, "kms:Decrypt")
      && try(s.Condition.ArnEquals["aws:PrincipalArn"], "") == "arn:aws:iam::123456789012:role/cd/cd-disputes-task"
    ]) == 0
    error_message = "No statement may allow kms:Decrypt to the disputes task role."
  }

  assert {
    condition = length([
      for s in jsondecode(aws_kms_key.this["evidence"].policy).Statement : s
      if s.Effect == "Deny" && contains(s.Action, "kms:Decrypt") && contains(s.Action, "kms:CreateGrant")
      && try(s.Condition.ArnEquals["aws:PrincipalArn"], "") == "arn:aws:iam::123456789012:role/cd/cd-disputes-task"
    ]) == 1
    error_message = "The evidence key policy must explicitly deny kms:Decrypt and kms:CreateGrant to the disputes task role."
  }

  assert {
    condition = toset([
      for s in jsondecode(aws_kms_key.this["data"].policy).Statement : s.Principal.Service
      if can(s.Principal.Service) && try(s.Condition.StringEquals["aws:SourceAccount"], "") == "123456789012"
    ]) == toset(["logs.eu-north-1.amazonaws.com", "events.amazonaws.com", "cloudwatch.amazonaws.com", "budgets.amazonaws.com"])
    error_message = "data key service principals must be logs, events, cloudwatch and budgets, each bound to aws:SourceAccount."
  }

  assert {
    condition = toset(one([for s in jsondecode(aws_kms_key.this["data"].policy).Statement : s.Condition.ArnLike["kms:EncryptionContext:aws:logs:arn"] if s.Sid == "CloudWatchLogs"])) == toset([
      "arn:aws:logs:eu-north-1:123456789012:log-group:/cd/*",
      "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cd-*",
      "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/rds/cluster/cd-*",
    ])
    error_message = "Logs may use cd-data for /cd/*, /aws/lambda/cd-* and the Aurora export groups /aws/rds/cluster/cd-*, nothing else."
  }

  assert {
    condition     = length([for s in jsondecode(aws_kms_key.this["evidence"].policy).Statement : s if can(s.Principal.Service)]) == 0
    error_message = "The evidence key must have no service principals (S3 acts with the caller's identity)."
  }
}

run "public_alb_fallback" {
  command = apply

  variables {
    edge_origin_mode = "public_alb"
  }

  assert {
    condition = length(concat(
      [for r in aws_vpc_security_group_ingress_rule.flow : r if r.from_port == 8081 && (r.security_group_id == aws_security_group.this["alb"].id || r.referenced_security_group_id == aws_security_group.this["alb"].id)],
      [for r in aws_vpc_security_group_egress_rule.flow : r if r.from_port == 8081 && (r.security_group_id == aws_security_group.this["alb"].id || r.referenced_security_group_id == aws_security_group.this["alb"].id)],
    )) == 0
    error_message = "In public_alb mode the ALB has no :8081 rules."
  }

  assert {
    condition = alltrue([
      for svc in ["users", "disputes"] : toset([
        for r in aws_vpc_security_group_ingress_rule.flow : r.referenced_security_group_id
        if r.security_group_id == aws_security_group.this[svc].id && r.from_port == 8081
        ]) == toset(concat(
        [aws_security_group.this["evidence-intake"].id, aws_security_group.this["dispute-notifier"].id],
        [for k in(svc == "users" ? ["transactions", "disputes"] : ["transactions"]) : aws_security_group.this[k].id],
      ))
    ])
    error_message = "In public_alb mode users and disputes :8081 accept the two Lambda SGs plus their service callers."
  }

  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.flow : r.cidr_ipv4 == null && r.cidr_ipv6 == null && r.prefix_list_id == null])
    error_message = "No ingress rule may use a CIDR or prefix list in fallback mode either."
  }
}

run "rejects_unknown_origin_mode" {
  command = plan

  variables {
    edge_origin_mode = "public"
  }

  expect_failures = [var.edge_origin_mode]
}
