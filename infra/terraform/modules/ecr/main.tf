data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  repository_keys = toset(var.repository_keys)
  lambda_keys     = toset([for k in var.repository_keys : k if startswith(k, "lambda-")])

  lambda_function_arn_pattern = "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.name_prefix}-*"

  lifecycle_policy = {
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last ${var.keep_images} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.keep_images
        }
        action = { type = "expire" }
      },
    ]
  }

  # Repository policies apply to the repository itself, so they carry no Resource element.
  lambda_pull_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "LambdaECRImageRetrievalPolicy"
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Condition = {
          StringLike = { "aws:sourceArn" = local.lambda_function_arn_pattern }
        }
      },
    ]
  }
}

resource "aws_ecr_repository" "this" {
  for_each = local.repository_keys

  name                 = "${var.name_prefix}-${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  tags = { component = "ecr" }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = local.repository_keys

  repository = aws_ecr_repository.this[each.key].name
  policy     = jsonencode(local.lifecycle_policy)
}

resource "aws_ecr_repository_policy" "lambda" {
  for_each = local.lambda_keys

  repository = aws_ecr_repository.this[each.key].name
  policy     = jsonencode(local.lambda_pull_policy)
}
