locals {
  default_tags = {
    project     = "card-dispute"
    environment = "dev"
    managed-by  = "terraform"
    repo        = var.github_repo
  }
}

provider "aws" {
  region = "eu-north-1"

  default_tags {
    tags = local.default_tags
  }
}

# CloudFront-scoped WAF ACLs can only be created in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.default_tags
  }
}
