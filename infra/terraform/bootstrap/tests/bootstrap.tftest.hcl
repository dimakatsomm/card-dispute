mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/test"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "af-south-1"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
      key_id = "00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::123456789012:policy/cd-workload-boundary"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/gha-infra-apply"
    }
  }
}

variables {
  github_repo = "acme/card-dispute"
}

run "trust_policies_pin_exact_subject_and_audience" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role.infra_plan.assume_role_policy).Statement) == 1 && length(jsondecode(aws_iam_role.infra_apply.assume_role_policy).Statement) == 1
    error_message = "Each infra role must have exactly one trust statement."
  }

  assert {
    condition     = jsondecode(aws_iam_role.infra_plan.assume_role_policy).Statement[0].Condition == { StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:acme/card-dispute:ref:refs/heads/main" } }
    error_message = "gha-infra-plan must trust only StringEquals aud sts.amazonaws.com and sub repo:acme/card-dispute:ref:refs/heads/main."
  }

  assert {
    condition     = jsondecode(aws_iam_role.infra_apply.assume_role_policy).Statement[0].Condition == { StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:acme/card-dispute:environment:dev-infra" } }
    error_message = "gha-infra-apply must trust only StringEquals aud sts.amazonaws.com and sub repo:acme/card-dispute:environment:dev-infra."
  }

  assert {
    condition     = jsondecode(aws_iam_role.infra_apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] != "repo:acme/card-dispute:environment:dev"
    error_message = "gha-infra-apply must not trust environment dev: every deploy, tools and e2e job runs there."
  }

  assert {
    condition = alltrue([
      for role in [aws_iam_role.infra_plan, aws_iam_role.infra_apply] :
      !strcontains(jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"], "*")
      && !startswith(jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"], "repo:acme/card-dispute:*")
    ])
    error_message = "No trust subject may contain a wildcard."
  }

  assert {
    condition = alltrue([
      for role in [aws_iam_role.infra_plan, aws_iam_role.infra_apply] :
      jsondecode(role.assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity"
      && jsondecode(role.assume_role_policy).Statement[0].Principal == { Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
    ])
    error_message = "Infra roles must be assumable only via the GitHub OIDC provider."
  }

  assert {
    condition     = aws_iam_openid_connect_provider.github.url == "https://token.actions.githubusercontent.com" && aws_iam_openid_connect_provider.github.client_id_list == toset(["sts.amazonaws.com"])
    error_message = "OIDC provider must be token.actions.githubusercontent.com with audience sts.amazonaws.com only."
  }
}

run "apply_role_creates_roles_only_with_boundary_and_path" {
  command = plan

  assert {
    condition = length([
      for s in flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]) : s
      if s.Effect == "Allow" && contains(lookup(s, "Action", []), "iam:CreateRole")
    ]) == 1
    error_message = "Exactly one statement may allow iam:CreateRole."
  }

  assert {
    condition = alltrue([
      for s in flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]) :
      s.Condition == { StringEquals = { "iam:PermissionsBoundary" = "arn:aws:iam::123456789012:policy/cd-workload-boundary" } }
      && s.Resource == ["arn:aws:iam::123456789012:role/cd/cd-*"]
      && length(setsubtract(["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary"], lookup(s, "Action", []))) == 0
      if s.Effect == "Allow" && contains(lookup(s, "Action", []), "iam:CreateRole")
    ])
    error_message = "CreateRole/PutRolePolicy/AttachRolePolicy/PutRolePermissionsBoundary must require boundary cd-workload-boundary on /cd/cd-* roles."
  }

  assert {
    condition = alltrue([
      for s in flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]) :
      contains(keys(lookup(s, "Condition", {})), "StringEquals") && contains(keys(s.Condition.StringEquals), "iam:PermissionsBoundary")
      if s.Effect == "Allow" && length(setintersection(["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary"], lookup(s, "Action", []))) > 0
    ])
    error_message = "No statement may grant role creation or policy changes without the boundary condition."
  }

  assert {
    condition = alltrue([
      for s in flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]) :
      contains(s.Action, "iam:DeleteRolePermissionsBoundary") && s.Resource == ["arn:aws:iam::123456789012:role/*"]
      if s.Sid == "DenyBoundaryRemoval"
    ])
    error_message = "Removing a permissions boundary must be denied on every role."
  }
}

run "pass_role_is_restricted_to_workload_path" {
  command = plan

  assert {
    condition = [
      for s in flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]) : s.Resource
      if s.Effect == "Allow" && contains(lookup(s, "Action", []), "iam:PassRole")
    ] == [["arn:aws:iam::123456789012:role/cd/*"]]
    error_message = "gha-infra-apply may pass only roles under /cd/."
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Resource
      if s.Effect == "Allow" && contains(lookup(s, "Action", []), "iam:PassRole")
    ] == [["arn:aws:iam::123456789012:role/cd/*"]]
    error_message = "The boundary may allow PassRole only for roles under /cd/."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.infra_plan.policy).Statement :
      !anytrue([for a in lookup(s, "Action", []) : startswith(a, "iam:")]) if s.Effect == "Allow"
    ])
    error_message = "gha-infra-plan must not be granted any IAM action beyond ReadOnlyAccess."
  }
}

run "apply_role_guardrails" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.infra_apply["guardrails"].policy).Statement :
      s.Effect == "Deny"
    ])
    error_message = "The guardrails policy must contain only Deny statements."
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_policy.infra_apply["guardrails"].policy).Statement : s.Condition
      if s.Sid == "DenyOutsideAllowedRegions"
    ] == [{ StringNotEquals = { "aws:RequestedRegion" = ["af-south-1", "us-east-1"] } }]
    error_message = "Requests outside af-south-1 and us-east-1 must be denied."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.infra_apply["guardrails"].policy).Statement :
      contains(s.NotAction, "iam:*") && contains(s.NotAction, "cloudfront:*") && !contains(s.NotAction, "ec2:*")
      if s.Sid == "DenyOutsideAllowedRegions"
    ])
    error_message = "Only global services may be exempt from the region guard."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.infra_apply["guardrails"].policy).Statement :
      contains(s.Resource, "arn:aws:iam::123456789012:role/gha-infra-apply") && contains(s.Resource, "arn:aws:iam::123456789012:role/gha-infra-plan") && contains(s.Action, "iam:PutRolePolicy") && contains(s.Action, "iam:AttachRolePolicy") && contains(s.Action, "iam:UpdateAssumeRolePolicy")
      if s.Sid == "DenyBootstrapRoleChanges"
    ])
    error_message = "gha-infra-apply must be denied changes to its own role and to gha-infra-plan."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.infra_apply["guardrails"].policy).Statement :
      contains(s.Resource, "arn:aws:iam::123456789012:policy/cd-workload-boundary") && contains(s.Resource, "arn:aws:iam::123456789012:policy/gha-infra-apply-guardrails") && contains(s.Action, "iam:CreatePolicyVersion")
      if s.Sid == "DenyBootstrapPolicyChanges"
    ])
    error_message = "gha-infra-apply must be denied changes to the boundary and to its own policies."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.infra_apply["guardrails"].policy).Statement :
      s.Resource == ["arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"] && contains(s.Action, "iam:DeleteOpenIDConnectProvider") && contains(s.Action, "iam:AddClientIDToOpenIDConnectProvider")
      if s.Sid == "DenyOidcProviderChanges"
    ])
    error_message = "gha-infra-apply must be denied changes to the GitHub OIDC provider."
  }

  assert {
    condition = length([
      for s in jsondecode(aws_iam_policy.infra_apply["guardrails"].policy).Statement : s
      if contains(["DenyOutsideAllowedRegions", "DenyBootstrapRoleChanges", "DenyBootstrapPolicyChanges", "DenyOidcProviderChanges", "DenyBoundaryRemoval", "DenyStateBucketChanges", "DenyStateKeyChanges"], s.Sid)
    ]) == 7
    error_message = "A guardrail statement is missing."
  }
}

run "apply_role_log_groups_are_prefix_scoped" {
  command = plan

  assert {
    condition = [
      for s in jsondecode(aws_iam_policy.infra_apply["compute"].policy).Statement : s.Resource
      if s.Effect == "Allow" && contains(lookup(s, "Action", []), "logs:CreateLogGroup")
      ] == [[
        "arn:aws:logs:af-south-1:123456789012:log-group:/cd/*",
        "arn:aws:logs:af-south-1:123456789012:log-group:/aws/lambda/cd-*",
        "arn:aws:logs:af-south-1:123456789012:log-group:/aws/rds/cluster/cd-*",
    ]]
    error_message = "gha-infra-apply may create log groups only under /cd/*, /aws/lambda/cd-* and /aws/rds/cluster/cd-*."
  }
}

run "boundary_caps_workloads" {
  command = plan

  assert {
    condition     = aws_iam_policy.boundary.name == "cd-workload-boundary"
    error_message = "Boundary must be named cd-workload-boundary."
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : { Resource = s.Resource, Condition = lookup(s, "Condition", null) }
      if s.Effect == "Allow" && contains(lookup(s, "Action", []), "ec2:CreateTags")
      ] == [{
        Resource = [
          "arn:aws:ec2:af-south-1:123456789012:network-insights-analysis/*",
          "arn:aws:ec2:af-south-1:123456789012:network-insights-path/*",
        ]
        Condition = { StringEquals = { "ec2:CreateAction" = ["CreateNetworkInsightsPath", "StartNetworkInsightsAnalysis"] } }
    }]
    error_message = "The boundary may allow ec2:CreateTags only on Reachability Analyzer paths/analyses at creation."
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Resource
      if s.Effect == "Allow" && length(setintersection(["ec2:DeleteNetworkInsightsPath", "ec2:DeleteNetworkInsightsAnalysis"], lookup(s, "Action", []))) > 0
      ] == [[
        "arn:aws:ec2:af-south-1:123456789012:network-insights-analysis/*",
        "arn:aws:ec2:af-south-1:123456789012:network-insights-path/*",
    ]]
    error_message = "Reachability Analyzer deletes must be scoped to path/analysis ARNs, not *."
  }

  assert {
    condition = alltrue([
      for action in ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:CreateAccessKey", "iam:CreateUser", "iam:CreatePolicyVersion", "iam:UpdateAssumeRolePolicy", "iam:DeleteRolePermissionsBoundary", "iam:AddUserToGroup", "iam:GetRole"] :
      anytrue([
        for s in jsondecode(aws_iam_policy.boundary.policy).Statement :
        s.Effect == "Deny" && anytrue([for pattern in lookup(s, "Action", []) : startswith(action, trimsuffix(pattern, "*"))])
      ])
    ])
    error_message = "The boundary must deny every IAM action other than PassRole."
  }

  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement :
      s.Effect == "Deny" && anytrue([for pattern in lookup(s, "Action", []) : startswith("iam:PassRole", trimsuffix(pattern, "*"))])
    ])
    error_message = "The boundary must not deny iam:PassRole (CI deploy roles pass their /cd/ task roles)."
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Action
      if s.Sid == "DenyOrganizations" && s.Effect == "Deny"
    ] == [["organizations:*"]]
    error_message = "The boundary must deny organizations:*."
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.NotResource
      if s.Effect == "Deny" && contains(lookup(s, "Action", []), "sts:AssumeRole")
    ] == [["arn:aws:iam::123456789012:role/cd/*"]]
    error_message = "The boundary must deny sts:AssumeRole on any role outside /cd/."
  }

  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement :
      s.Effect == "Allow" && contains(lookup(s, "Action", []), "events:PutEvents")
    ])
    error_message = "No workload publishes to EventBridge, so the boundary must not allow events:PutEvents."
  }
}

run "no_wildcards_outside_documented_exceptions" {
  command = plan

  assert {
    condition = alltrue([
      for s in concat(
        flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]),
        jsondecode(aws_iam_role_policy.infra_plan.policy).Statement,
        jsondecode(aws_iam_policy.boundary.policy).Statement,
      ) :
      !anytrue([for a in lookup(s, "Action", []) : a == "*" || endswith(a, ":*")])
      if s.Effect == "Allow"
    ])
    error_message = "No Allow statement may use * or service:* as an action."
  }

  assert {
    condition = alltrue([
      for s in concat(
        flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]),
        jsondecode(aws_iam_role_policy.infra_plan.policy).Statement,
        jsondecode(aws_iam_policy.boundary.policy).Statement,
      ) :
      contains(["NoResourceLevelCreate", "EventSourceMappingCreate", "HostedZoneCreate", "NoResourceLevelActions"], s.Sid)
      if s.Effect == "Allow" && contains(flatten([lookup(s, "Resource", [])]), "*")
    ])
    error_message = "Resource * is allowed only in the documented no-resource-level statements."
  }

  assert {
    condition = alltrue([
      for s in concat(
        flatten([for p in aws_iam_policy.infra_apply : jsondecode(p.policy).Statement]),
        jsondecode(aws_iam_role_policy.infra_plan.policy).Statement,
        jsondecode(aws_iam_policy.boundary.policy).Statement,
        jsondecode(aws_s3_bucket_policy.state.policy).Statement,
        jsondecode(aws_kms_key.state.policy).Statement,
      ) : lookup(s, "Sid", "") != ""
    ])
    error_message = "Every statement needs a Sid."
  }

  assert {
    condition     = alltrue([for p in concat(values(aws_iam_policy.infra_apply), [aws_iam_policy.boundary]) : length(p.policy) <= 6144])
    error_message = "A managed policy exceeds the 6,144-character IAM limit."
  }

  assert {
    condition     = length(aws_iam_role_policy.infra_plan.policy) <= 10240
    error_message = "The plan role inline policy exceeds the 10,240-character IAM limit."
  }
}

run "plan_role_state_access" {
  command = plan

  assert {
    condition = [
      for s in jsondecode(aws_iam_role_policy.infra_plan.policy).Statement : s.Resource
      if s.Effect == "Allow" && contains(s.Action, "s3:PutObject")
    ] == [["arn:aws:s3:::cd-tfstate-123456789012/envs/dev/*.tflock"], ["arn:aws:s3:::cd-tfstate-123456789012/plans/*"]]
    error_message = "gha-infra-plan may write only the lock key and plans/*."
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_role_policy.infra_plan.policy).Statement : s.Resource
      if s.Sid == "StateKey"
    ] == [["arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"]]
    error_message = "gha-infra-plan must use the state key by ARN."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.infra_plan_read_only.policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess"
    error_message = "gha-infra-plan must attach ReadOnlyAccess."
  }
}

run "state_bucket_is_locked_down" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "cd-tfstate-123456789012"
    error_message = "Default state bucket name must derive from the prefix and account id."
  }

  assert {
    condition = one([
      for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s
      if s.Sid == "DenyInsecureTransport"
      ]) == {
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::cd-tfstate-123456789012", "arn:aws:s3:::cd-tfstate-123456789012/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }
    error_message = "The bucket policy must deny every non-TLS request."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets
    error_message = "All four public access block flags must be on."
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State bucket must be versioned."
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.state.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "Object ownership must be BucketOwnerEnforced."
  }

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.state.rule :
      one(r.apply_server_side_encryption_by_default).sse_algorithm == "aws:kms" && one(r.apply_server_side_encryption_by_default).kms_master_key_id == "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    ])
    error_message = "State bucket must default to SSE-KMS with the state key."
  }

  assert {
    condition     = aws_kms_key.state.enable_key_rotation
    error_message = "State key rotation must be on."
  }

  assert {
    condition = alltrue([
      for type, r in { aws_s3_bucket = aws_s3_bucket.state, aws_kms_key = aws_kms_key.state } :
      can(regex("resource \"${type}\" \"state\" \\{[^}]*lifecycle\\s*\\{\\s*prevent_destroy\\s*=\\s*true", file("state.tf")))
    ])
    error_message = "State bucket and state key must both set lifecycle prevent_destroy = true."
  }
}

run "rejects_placeholder_repo" {
  command = plan

  variables {
    github_repo = "PLACEHOLDER/card-dispute"
  }

  expect_failures = [var.github_repo]
}

run "rejects_state_bucket_in_apply_role_namespace" {
  command = plan

  variables {
    state_bucket_name = "cd-dev-tfstate"
  }

  expect_failures = [var.state_bucket_name]
}
