provider "aws" {
  region = "eu-north-1"

  default_tags {
    tags = {
      project     = "card-dispute"
      environment = "dev"
      managed-by  = "terraform"
      repo        = var.github_repo
      component   = "bootstrap"
    }
  }
}
