mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-north-1", name = "eu-north-1" }
  }
}

override_resource {
  target = aws_s3_bucket.quarantine
  values = {
    id  = "cd-dev-quarantine-123456789012"
    arn = "arn:aws:s3:::cd-dev-quarantine-123456789012"
  }
}

override_resource {
  target = aws_s3_bucket.evidence
  values = {
    id  = "cd-dev-evidence-123456789012"
    arn = "arn:aws:s3:::cd-dev-evidence-123456789012"
  }
}

override_resource {
  target = aws_iam_role.guardduty
  values = {
    arn = "arn:aws:iam::123456789012:role/cd/cd-quarantine-scan-role"
    id  = "cd-quarantine-scan-role"
  }
}

override_resource {
  target = aws_cloudwatch_event_rule.scan_result
  values = {
    arn = "arn:aws:events:eu-north-1:123456789012:rule/cd-evidence-scan-result"
  }
}

override_resource {
  target = aws_guardduty_malware_protection_plan.quarantine
  values = {
    arn = "arn:aws:guardduty:eu-north-1:123456789012:malware-protection-plan/0000000000000000000000000000000000000000"
  }
}

variables {
  name_prefix              = "cd"
  permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cd-workload-boundary"
  iam_path                 = "/cd/"
  kms_key_arn              = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  allowed_upload_origin    = "https://d111111abcdef8.cloudfront.net"
  enable_intake_target     = true
  intake_function_name     = "cd-evidence-intake"
  intake_alias_arn         = "arn:aws:lambda:eu-north-1:123456789012:function:cd-evidence-intake:live"
  intake_dlq_arn           = "arn:aws:sqs:eu-north-1:123456789012:cd-evidence-intake-dlq"
}

run "quarantine_bucket" {
  command = apply

  assert {
    condition     = aws_s3_bucket.quarantine.bucket == "cd-dev-quarantine-123456789012" && aws_s3_bucket.evidence.bucket == "cd-dev-evidence-123456789012"
    error_message = "Bucket names must follow cd-dev-<component>-<account-id>."
  }

  assert {
    condition = alltrue([for b in [aws_s3_bucket_public_access_block.quarantine, aws_s3_bucket_public_access_block.evidence] :
    b.block_public_acls && b.block_public_policy && b.ignore_public_acls && b.restrict_public_buckets])
    error_message = "Block Public Access must be fully on for both buckets."
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.quarantine.rule[0].object_ownership == "BucketOwnerEnforced" && aws_s3_bucket_ownership_controls.evidence.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "Object ownership must be BucketOwnerEnforced on both buckets."
  }

  assert {
    condition     = aws_s3_bucket_versioning.quarantine.versioning_configuration[0].status == "Disabled" && aws_s3_bucket_versioning.evidence.versioning_configuration[0].status == "Enabled"
    error_message = "Quarantine must be unversioned and evidence versioned."
  }

  assert {
    condition = alltrue([for c in [aws_s3_bucket_server_side_encryption_configuration.quarantine, aws_s3_bucket_server_side_encryption_configuration.evidence] :
      one(c.rule).bucket_key_enabled &&
      one(one(c.rule).apply_server_side_encryption_by_default).sse_algorithm == "aws:kms" &&
    one(one(c.rule).apply_server_side_encryption_by_default).kms_master_key_id == var.kms_key_arn])
    error_message = "Both buckets must default to SSE-KMS with the evidence key and bucket key on."
  }

  assert {
    condition = (
      one(aws_s3_bucket_lifecycle_configuration.quarantine.rule).expiration[0].days == 1 &&
      one(aws_s3_bucket_lifecycle_configuration.quarantine.rule).abort_incomplete_multipart_upload[0].days_after_initiation == 1 &&
      one(aws_s3_bucket_lifecycle_configuration.quarantine.rule).status == "Enabled"
    )
    error_message = "Quarantine objects and incomplete multipart uploads must expire after 1 day."
  }

  assert {
    condition = (
      one([for r in aws_s3_bucket_lifecycle_configuration.evidence.rule : r if r.id == "expire-evidence"]).filter[0].prefix == "evidence/" &&
      one([for r in aws_s3_bucket_lifecycle_configuration.evidence.rule : r if r.id == "expire-evidence"]).expiration[0].days == 365 &&
      one([for r in aws_s3_bucket_lifecycle_configuration.evidence.rule : r if r.id == "expire-evidence"]).noncurrent_version_expiration[0].noncurrent_days == 30
    )
    error_message = "Evidence must expire evidence/ after 365 days and noncurrent versions after 30."
  }

  assert {
    condition = (
      one(aws_s3_bucket_cors_configuration.quarantine.cors_rule).allowed_origins == toset(["https://d111111abcdef8.cloudfront.net"]) &&
      !contains(one(aws_s3_bucket_cors_configuration.quarantine.cors_rule).allowed_origins, "*") &&
      one(aws_s3_bucket_cors_configuration.quarantine.cors_rule).allowed_methods == toset(["PUT"])
    )
    error_message = "CORS must allow PUT only, from exactly the CloudFront origin, never *."
  }

  assert {
    condition = (
      one(aws_s3_bucket_cors_configuration.quarantine.cors_rule).allowed_headers == toset(["content-type", "content-length", "x-amz-checksum-sha256"]) &&
      one(aws_s3_bucket_cors_configuration.quarantine.cors_rule).expose_headers == toset(["ETag"]) &&
      one(aws_s3_bucket_cors_configuration.quarantine.cors_rule).max_age_seconds == 300
    )
    error_message = "CORS must allow exactly the signed headers, expose ETag and cache preflight for 300 s."
  }
}

run "quarantine_policy_denies_unscanned_reads" {
  command = apply

  assert {
    condition = one([for s in jsondecode(aws_s3_bucket_policy.quarantine.policy).Statement : s if s.Sid == "DenyReadUnlessScannedClean"]) == {
      Sid       = "DenyReadUnlessScannedClean"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:GetObject", "s3:GetObjectVersion"]
      Resource  = ["arn:aws:s3:::cd-dev-quarantine-123456789012/*"]
      Condition = {
        StringNotEquals = {
          "s3:ExistingObjectTag/GuardDutyMalwareScanStatus" = "NO_THREATS_FOUND"
          "aws:PrincipalArn"                                = "arn:aws:iam::123456789012:role/cd/cd-quarantine-scan-role"
        }
      }
    }
    error_message = "GetObject must be denied unless tagged NO_THREATS_FOUND, exempting exactly the GuardDuty role."
  }

  assert {
    condition     = !strcontains(aws_s3_bucket_policy.quarantine.policy, "evidence-intake")
    error_message = "The intake role must not be exempt from (or mentioned in) the quarantine policy."
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.quarantine.policy).Statement : s.Effect == "Deny"])
    error_message = "The quarantine policy may only deny; access is granted by IAM."
  }

  assert {
    condition     = !strcontains(aws_s3_bucket_policy.quarantine.policy, "s3:x-amz-server-side-encryption")
    error_message = "No deny-unencrypted-PUT rule: the browser PUT relies on default encryption."
  }
}

run "quarantine_policy_guards_scan_tag_writes" {
  command = apply

  assert {
    condition = one([for s in jsondecode(aws_s3_bucket_policy.quarantine.policy).Statement : s if s.Sid == "DenyTagWritesExceptGuardDuty"]) == {
      Sid       = "DenyTagWritesExceptGuardDuty"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging", "s3:DeleteObjectTagging"]
      Resource  = ["arn:aws:s3:::cd-dev-quarantine-123456789012/*"]
      Condition = { StringNotEquals = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/cd/cd-quarantine-scan-role" } }
    }
    error_message = "Only the GuardDuty role may put, version-put or delete object tags in quarantine."
  }

  assert {
    condition = one([for s in jsondecode(aws_s3_bucket_policy.quarantine.policy).Statement : s if s.Sid == "DenyUploadWithScanTag"]) == {
      Sid       = "DenyUploadWithScanTag"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:PutObject"]
      Resource  = ["arn:aws:s3:::cd-dev-quarantine-123456789012/*"]
      Condition = {
        Null            = { "s3:RequestObjectTag/GuardDutyMalwareScanStatus" = "false" }
        StringNotEquals = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/cd/cd-quarantine-scan-role" }
      }
    }
    error_message = "An upload carrying a GuardDutyMalwareScanStatus tag must be denied to everyone but GuardDuty."
  }

  assert {
    condition = one([for s in jsondecode(aws_s3_bucket_policy.quarantine.policy).Statement : s if s.Sid == "DenyUploadOutsideIntake"]) == {
      Sid         = "DenyUploadOutsideIntake"
      Effect      = "Deny"
      Principal   = "*"
      Action      = ["s3:PutObject"]
      NotResource = ["arn:aws:s3:::cd-dev-quarantine-123456789012/intake/*"]
      Condition   = { StringNotEquals = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/cd/cd-quarantine-scan-role" } }
    }
    error_message = "Uploads outside intake/* must be denied, exempting only GuardDuty (its validation object)."
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.guardduty.policy).Statement : s.Resource if s.Sid == "AllowPutValidationObject"]) == [
      "arn:aws:s3:::cd-dev-quarantine-123456789012/malware-protection-resource-validation-object",
    ]
    error_message = "GuardDuty writes its validation object outside intake/, which the role exemption must cover."
  }
}

run "tls_only_on_both_buckets" {
  command = apply

  assert {
    condition = alltrue([for p in [aws_s3_bucket_policy.quarantine.policy, aws_s3_bucket_policy.evidence.policy] :
      length([for s in jsondecode(p).Statement : s if
        s.Effect == "Deny" && s.Principal == "*" && s.Action == "s3:*" &&
    s.Condition == { Bool = { "aws:SecureTransport" = "false" } }]) == 1])
    error_message = "Both buckets must deny every request without TLS."
  }

  assert {
    condition = (
      contains(one([for s in jsondecode(aws_s3_bucket_policy.evidence.policy).Statement : s if s.Sid == "DenyNonTls"]).Resource, "arn:aws:s3:::cd-dev-evidence-123456789012/*") &&
      contains(one([for s in jsondecode(aws_s3_bucket_policy.quarantine.policy).Statement : s if s.Sid == "DenyNonTls"]).Resource, "arn:aws:s3:::cd-dev-quarantine-123456789012")
    )
    error_message = "The TLS deny must cover the bucket and its objects."
  }
}

run "guardduty_plan_and_role" {
  command = apply

  assert {
    condition     = one(one(aws_guardduty_malware_protection_plan.quarantine.actions).tagging).status == "ENABLED"
    error_message = "The malware protection plan must tag scanned objects."
  }

  assert {
    condition     = one(one(aws_guardduty_malware_protection_plan.quarantine.protected_resource).s3_bucket).bucket_name == "cd-dev-quarantine-123456789012"
    error_message = "The plan must protect the quarantine bucket."
  }

  assert {
    condition = jsondecode(aws_iam_role.guardduty.assume_role_policy).Statement[0].Principal == { Service = "malware-protection-plan.guardduty.amazonaws.com" } && jsondecode(aws_iam_role.guardduty.assume_role_policy).Statement[0].Condition == {
      StringEquals = { "aws:SourceAccount" = "123456789012" }
      ArnLike      = { "aws:SourceArn" = "arn:aws:guardduty:eu-north-1:123456789012:malware-protection-plan/*" }
    }
    error_message = "Only GuardDuty malware protection plans in this account may assume the role."
  }

  assert {
    condition     = aws_iam_role.guardduty.path == "/cd/" && aws_iam_role.guardduty.permissions_boundary == var.permissions_boundary_arn
    error_message = "The GuardDuty role must use the /cd/ path and the workload boundary."
  }

  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.guardduty.policy).Statement :
      alltrue([for a in s.Action : a != "*" && !endswith(a, ":*")]) &&
    alltrue([for r in s.Resource : r != "*"])])
    error_message = "The GuardDuty role policy must not use wildcard actions or resources."
  }

  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.guardduty.policy).Statement :
      alltrue([for r in s.Resource :
        startswith(r, "arn:aws:s3:::cd-dev-quarantine-123456789012") ||
        r == var.kms_key_arn ||
    r == "arn:aws:events:eu-north-1:123456789012:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"])])
    error_message = "The GuardDuty role may touch only the quarantine bucket, the evidence key and its managed rule."
  }
}

run "scan_result_rule_targets_intake" {
  command = apply

  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.scan_result.event_pattern) == {
      source        = ["aws.guardduty"]
      "detail-type" = ["GuardDuty Malware Protection Object Scan Result"]
      detail        = { s3ObjectDetails = { bucketName = ["cd-dev-quarantine-123456789012"] } }
    }
    error_message = "The rule must match only GuardDuty scan results for the quarantine bucket."
  }

  assert {
    condition     = aws_cloudwatch_event_rule.scan_result.event_bus_name == "default"
    error_message = "The rule must be on the default bus, where GuardDuty publishes."
  }

  assert {
    condition = (
      aws_cloudwatch_event_target.intake[0].arn == var.intake_alias_arn &&
      aws_cloudwatch_event_target.intake[0].retry_policy[0].maximum_retry_attempts == 2 &&
      aws_cloudwatch_event_target.intake[0].retry_policy[0].maximum_event_age_in_seconds == 3600 &&
      aws_cloudwatch_event_target.intake[0].dead_letter_config[0].arn == var.intake_dlq_arn
    )
    error_message = "The target must be the intake alias with 2 retries, 1 h max age and the intake DLQ."
  }

  assert {
    condition = (
      aws_lambda_permission.scan_result[0].principal == "events.amazonaws.com" &&
      aws_lambda_permission.scan_result[0].source_arn == "arn:aws:events:eu-north-1:123456789012:rule/cd-evidence-scan-result" &&
      aws_lambda_permission.scan_result[0].qualifier == "live" &&
      aws_lambda_permission.scan_result[0].function_name == "cd-evidence-intake" &&
      aws_lambda_permission.scan_result[0].action == "lambda:InvokeFunction"
    )
    error_message = "Only EventBridge, for this rule, may invoke the intake alias live."
  }

  assert {
    condition     = output.quarantine_bucket_regional_origin == "https://cd-dev-quarantine-123456789012.s3.eu-north-1.amazonaws.com"
    error_message = "The regional origin must be https://<bucket>.s3.eu-north-1.amazonaws.com."
  }
}

run "no_target_without_intake_function" {
  command = plan

  variables {
    enable_intake_target = false
    intake_function_name = null
    intake_alias_arn     = null
  }

  assert {
    condition     = length(aws_cloudwatch_event_target.intake) == 0 && length(aws_lambda_permission.scan_result) == 0
    error_message = "No target or Lambda permission may exist before the intake function does."
  }
}

run "target_requires_intake_function" {
  command = plan

  variables {
    intake_function_name = null
    intake_alias_arn     = "arn:aws:lambda:eu-north-1:123456789012:function:cd-evidence-intake"
  }

  expect_failures = [var.intake_function_name, var.intake_alias_arn]
}

run "wildcard_origin_rejected" {
  command = plan

  variables {
    allowed_upload_origin = "*"
  }

  expect_failures = [var.allowed_upload_origin]
}
