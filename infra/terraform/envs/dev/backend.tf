# terraform -chdir=infra/terraform/envs/dev init -backend-config="bucket=<bootstrap state_bucket_name>" -backend-config="key=envs/dev/terraform.tfstate" -backend-config="region=af-south-1"
terraform {
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}
