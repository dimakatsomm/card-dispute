resource "aws_kms_key" "state" {
  description             = "Terraform state and stored plans"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = jsonencode(local.state_key_policy)

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = local.state_key_alias
  target_key_id = aws_kms_key.state.key_id
}

#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_18:Access logs would need a second bucket; only the two OIDC roles and the owner can reach this one.
  #checkov:skip=CKV2_AWS_62:No consumer for state-object events.
  #checkov:skip=CKV_AWS_144:Single-region dev; versioning, 90-day noncurrent versions and prevent_destroy cover loss.
  bucket = local.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # Stored plans embed secret values, so they are short-lived (ADR-060).
  rule {
    id     = "expire-plans"
    status = "Enabled"

    filter {
      prefix = "plans/"
    }

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode(local.state_bucket_policy)

  depends_on = [aws_s3_bucket_public_access_block.state]
}
