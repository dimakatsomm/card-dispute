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
}

variables {
  name_prefix = "cd"
  kms_key_arn = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
}

run "repositories_are_immutable_scanned_and_encrypted" {
  command = apply

  assert {
    condition = toset(keys(aws_ecr_repository.this)) == toset([
      "svc-auth", "svc-users", "svc-transactions", "svc-disputes", "web",
      "lambda-evidence-intake", "lambda-dispute-notifier", "lambda-retention-sweeper",
      "dev-tools",
    ])
    error_message = "Exactly the nine contract repositories must exist."
  }

  assert {
    condition     = alltrue([for k, r in aws_ecr_repository.this : r.name == "cd-${k}"])
    error_message = "Repository names must be cd-<repo key>."
  }

  assert {
    condition     = alltrue([for r in aws_ecr_repository.this : r.image_tag_mutability == "IMMUTABLE"])
    error_message = "Every repository must have immutable tags."
  }

  assert {
    condition     = alltrue([for r in aws_ecr_repository.this : r.image_scanning_configuration[0].scan_on_push])
    error_message = "Every repository must scan on push."
  }

  assert {
    condition = alltrue([for r in aws_ecr_repository.this :
    r.encryption_configuration[0].encryption_type == "KMS" && r.encryption_configuration[0].kms_key == var.kms_key_arn])
    error_message = "Every repository must be encrypted with cd-data."
  }
}

run "lifecycle_keeps_ten_and_expires_untagged_after_a_day" {
  command = plan

  assert {
    condition     = keys(aws_ecr_lifecycle_policy.this) == keys(aws_ecr_repository.this)
    error_message = "Every repository must have a lifecycle policy."
  }

  assert {
    condition = alltrue([for p in aws_ecr_lifecycle_policy.this :
      length([for r in jsondecode(p.policy).rules : r
        if r.selection.tagStatus == "untagged" && r.selection.countType == "sinceImagePushed" && r.selection.countNumber == 1 && r.action.type == "expire"
    ]) == 1])
    error_message = "Untagged images must expire after 1 day."
  }

  assert {
    condition = alltrue([for p in aws_ecr_lifecycle_policy.this :
      length([for r in jsondecode(p.policy).rules : r
        if r.selection.tagStatus == "any" && r.selection.countType == "imageCountMoreThan" && r.selection.countNumber == 10 && r.action.type == "expire"
    ]) == 1])
    error_message = "The last 10 images must be kept."
  }
}

run "only_lambda_repos_have_a_source_arn_scoped_pull_policy" {
  command = apply

  assert {
    condition     = toset(keys(aws_ecr_repository_policy.lambda)) == toset(["lambda-evidence-intake", "lambda-dispute-notifier", "lambda-retention-sweeper"])
    error_message = "Only the three Lambda repositories may carry a repository policy."
  }

  assert {
    condition = alltrue([for p in aws_ecr_repository_policy.lambda : alltrue([for s in jsondecode(p.policy).Statement :
      s.Effect == "Allow" &&
      s.Principal == { Service = "lambda.amazonaws.com" } &&
      toset(s.Action) == toset(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) &&
      s.Condition.StringLike["aws:sourceArn"] == "arn:aws:lambda:eu-north-1:123456789012:function:cd-*"
    ])])
    error_message = "The Lambda pull policy must allow only lambda.amazonaws.com to pull, scoped by aws:sourceArn to this account's cd- functions."
  }
}
