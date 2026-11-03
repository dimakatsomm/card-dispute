#!/usr/bin/env bash
# Owner runs this: applies the reviewed saved plan bs.tfplan (from plan-bootstrap.sh), then deletes it.
set -euo pipefail
export AWS_REGION=eu-north-1 AWS_DEFAULT_REGION=eu-north-1 MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
eval "$(aws configure export-credentials --format env)"
terraform -chdir=infra/terraform/bootstrap apply -input=false -no-color bs.tfplan | grep -E "Apply complete|Error" | sed -E 's/[0-9]{12}/<acct>/g'
rm -f infra/terraform/bootstrap/bs.tfplan
