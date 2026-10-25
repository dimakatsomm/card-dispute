data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  quarantine_bucket_name = "${var.name_prefix}-dev-quarantine-${local.account_id}"
  evidence_bucket_name   = "${var.name_prefix}-dev-evidence-${local.account_id}"
  quarantine_bucket_arn  = "arn:${local.partition}:s3:::${local.quarantine_bucket_name}"
  evidence_bucket_arn    = "arn:${local.partition}:s3:::${local.evidence_bucket_name}"

  guardduty_principal       = "malware-protection-plan.guardduty.amazonaws.com"
  guardduty_managed_rule    = "arn:${local.partition}:events:${local.region}:${local.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"
  noncurrent_evidence_days  = 30
  scan_status_tag           = "GuardDutyMalwareScanStatus"
  scan_clean_value          = "NO_THREATS_FOUND"
  guardduty_validation_key  = "malware-protection-resource-validation-object"
  intake_prefix             = "intake/"
  evidence_prefix           = "evidence/"
  intake_alias_name         = "live"
  scan_result_detail_type   = "GuardDuty Malware Protection Object Scan Result"
  intake_target_max_retries = 2
  intake_target_max_age_s   = 3600

  deny_non_tls = {
    for key, arn in { quarantine = local.quarantine_bucket_arn, evidence = local.evidence_bucket_arn } : key => {
      Sid                        = "DenyNonTls"
      Effect                     = "Deny"
      Principal                  = "*"
      # Deny-only wildcard: TLS must be required for every S3 action.
      Action    = "s3:*"
      Resource  = [arn, "${arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }
  }

  # No deny-unencrypted-PUT: the browser PUT carries no SSE header, so bucket default SSE-KMS applies.
  quarantine_policy = {
    Version = "2012-10-17"
    Statement = [
      local.deny_non_tls.quarantine,
      {
        Sid       = "DenyReadUnlessScannedClean"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource  = ["${local.quarantine_bucket_arn}/*"]
        Condition = {
          StringNotEquals = {
            "s3:ExistingObjectTag/${local.scan_status_tag}" = local.scan_clean_value
            "aws:PrincipalArn"                              = aws_iam_role.guardduty.arn
          }
        }
      },
      # The scan tag gates reads, so only GuardDuty may write tags.
      {
        Sid       = "DenyTagWritesExceptGuardDuty"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging", "s3:DeleteObjectTagging"]
        Resource  = ["${local.quarantine_bucket_arn}/*"]
        Condition = { StringNotEquals = { "aws:PrincipalArn" = aws_iam_role.guardduty.arn } }
      },
      {
        Sid       = "DenyUploadWithScanTag"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObject"]
        Resource  = ["${local.quarantine_bucket_arn}/*"]
        Condition = {
          Null            = { "s3:RequestObjectTag/${local.scan_status_tag}" = "false" }
          StringNotEquals = { "aws:PrincipalArn" = aws_iam_role.guardduty.arn }
        }
      },
      # GuardDuty's validation object sits outside intake/ and is covered by the role exemption.
      {
        Sid         = "DenyUploadOutsideIntake"
        Effect      = "Deny"
        Principal   = "*"
        Action      = ["s3:PutObject"]
        NotResource = ["${local.quarantine_bucket_arn}/${local.intake_prefix}*"]
        Condition   = { StringNotEquals = { "aws:PrincipalArn" = aws_iam_role.guardduty.arn } }
      },
    ]
  }

  # Intake CopyObject sends no ServerSideEncryption, so a deny-non-KMS PUT rule would refuse every promotion.
  evidence_policy = {
    Version   = "2012-10-17"
    Statement = [local.deny_non_tls.evidence]
  }

  guardduty_trust_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "GuardDutyMalwareProtectionAssume"
        Effect    = "Allow"
        Principal = { Service = local.guardduty_principal }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          # The plan ARN is assigned after the plan is created with this role, so match the account's plans.
          ArnLike = { "aws:SourceArn" = "arn:${local.partition}:guardduty:${local.region}:${local.account_id}:malware-protection-plan/*" }
        }
      },
    ]
  }

  guardduty_role_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowManagedRuleToSendS3EventsToGuardDuty"
        Effect    = "Allow"
        Action    = ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"]
        Resource  = [local.guardduty_managed_rule]
        Condition = { StringLike = { "events:ManagedBy" = local.guardduty_principal } }
      },
      {
        Sid      = "AllowGuardDutyToMonitorEventBridgeManagedRule"
        Effect   = "Allow"
        Action   = ["events:DescribeRule", "events:ListTargetsByRule"]
        Resource = [local.guardduty_managed_rule]
      },
      {
        Sid    = "AllowPostScanTag"
        Effect = "Allow"
        Action = [
          "s3:GetObjectTagging",
          "s3:GetObjectVersionTagging",
          "s3:PutObjectTagging",
          "s3:PutObjectVersionTagging",
        ]
        Resource = ["${local.quarantine_bucket_arn}/*"]
      },
      {
        Sid      = "AllowEnableS3EventBridgeEvents"
        Effect   = "Allow"
        Action   = ["s3:GetBucketNotification", "s3:PutBucketNotification"]
        Resource = [local.quarantine_bucket_arn]
      },
      {
        Sid      = "AllowPutValidationObject"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${local.quarantine_bucket_arn}/${local.guardduty_validation_key}"]
      },
      {
        Sid      = "AllowCheckBucketOwnership"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [local.quarantine_bucket_arn]
      },
      {
        Sid      = "AllowMalwareScan"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = ["${local.quarantine_bucket_arn}/*"]
      },
      {
        Sid       = "AllowDecryptForMalwareScan"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = [var.kms_key_arn]
        Condition = { StringLike = { "kms:ViaService" = "s3.${local.region}.amazonaws.com" } }
      },
    ]
  }

  scan_result_pattern = {
    source        = ["aws.guardduty"]
    "detail-type" = [local.scan_result_detail_type]
    detail = {
      s3ObjectDetails = { bucketName = [local.quarantine_bucket_name] }
    }
  }
}

#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "quarantine" {
  #checkov:skip=CKV_AWS_18:Access logs need a separate log bucket; deferred for dev with mock data only.
  #checkov:skip=CKV_AWS_21:Unversioned on purpose: untrusted bytes live at most a day and are deleted after intake.
  #checkov:skip=CKV2_AWS_62:GuardDuty enables the EventBridge notification it needs; nothing else consumes object events.
  #checkov:skip=CKV_AWS_144:Single-region dev (eu-north-1); quarantine objects are transient.
  bucket = local.quarantine_bucket_name
  tags   = { component = "evidence-buckets" }
}

resource "aws_s3_bucket_public_access_block" "quarantine" {
  bucket                  = aws_s3_bucket.quarantine.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Objects live at most a day and are deleted after promotion; versions would only keep untrusted bytes around.
resource "aws_s3_bucket_versioning" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  versioning_configuration {
    status = "Disabled" #tfsec:ignore:aws-s3-enable-versioning
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  rule {
    id     = "expire-quarantine"
    status = "Enabled"

    filter {}

    expiration {
      days = var.quarantine_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = var.quarantine_expiration_days
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = [var.allowed_upload_origin]
    allowed_headers = ["content-type", "content-length", "x-amz-checksum-sha256"]
    expose_headers  = ["ETag"]
    max_age_seconds = 300
  }
}

resource "aws_s3_bucket_policy" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id
  policy = jsonencode(local.quarantine_policy)

  depends_on = [aws_s3_bucket_public_access_block.quarantine]
}

#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "evidence" {
  #checkov:skip=CKV_AWS_18:Access logs need a separate log bucket; deferred for dev with mock data only.
  #checkov:skip=CKV2_AWS_62:No consumer for evidence-object events; the DB records every promotion.
  #checkov:skip=CKV_AWS_144:Single-region dev (eu-north-1); versioning covers accidental loss.
  bucket = local.evidence_bucket_name
  tags   = { component = "evidence-buckets" }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    id     = "expire-evidence"
    status = "Enabled"

    filter {
      prefix = local.evidence_prefix
    }

    expiration {
      days = var.evidence_expiration_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.noncurrent_evidence_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.evidence]
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = jsonencode(local.evidence_policy)

  depends_on = [aws_s3_bucket_public_access_block.evidence]
}

resource "aws_iam_role" "guardduty" {
  name                 = "${var.name_prefix}-quarantine-scan-role"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = jsonencode(local.guardduty_trust_policy)
  tags                 = { component = "evidence-buckets" }
}

resource "aws_iam_role_policy" "guardduty" {
  name   = "${var.name_prefix}-quarantine-scan"
  role   = aws_iam_role.guardduty.id
  policy = jsonencode(local.guardduty_role_policy)
}

# Standalone S3 malware protection needs no GuardDuty detector; first-time enablement errors are OWN-5.
resource "aws_guardduty_malware_protection_plan" "quarantine" {
  role = aws_iam_role.guardduty.arn

  protected_resource {
    s3_bucket {
      bucket_name     = aws_s3_bucket.quarantine.id
      object_prefixes = [local.intake_prefix]
    }
  }

  actions {
    tagging {
      status = "ENABLED"
    }
  }

  tags = { component = "evidence-buckets" }

  # GuardDuty validates bucket, key and EventBridge access when the plan is created.
  depends_on = [
    aws_iam_role_policy.guardduty,
    aws_s3_bucket_policy.quarantine,
    aws_s3_bucket_server_side_encryption_configuration.quarantine,
  ]
}

resource "aws_cloudwatch_event_rule" "scan_result" {
  name           = "${var.name_prefix}-evidence-scan-result"
  description    = "GuardDuty malware scan results for the quarantine bucket"
  event_bus_name = "default"
  event_pattern  = jsonencode(local.scan_result_pattern)
  tags           = { component = "evidence-buckets" }
}

resource "aws_cloudwatch_event_target" "intake" {
  count = var.enable_intake_target ? 1 : 0

  rule           = aws_cloudwatch_event_rule.scan_result.name
  event_bus_name = aws_cloudwatch_event_rule.scan_result.event_bus_name
  target_id      = "evidence-intake-live"
  arn            = var.intake_alias_arn

  retry_policy {
    maximum_retry_attempts       = local.intake_target_max_retries
    maximum_event_age_in_seconds = local.intake_target_max_age_s
  }

  dead_letter_config {
    arn = var.intake_dlq_arn
  }

  depends_on = [aws_lambda_permission.scan_result]
}

resource "aws_lambda_permission" "scan_result" {
  count = var.enable_intake_target ? 1 : 0

  statement_id   = "AllowEvidenceScanResultRule"
  action         = "lambda:InvokeFunction"
  function_name  = var.intake_function_name
  qualifier      = local.intake_alias_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.scan_result.arn
  source_account = local.account_id
}
