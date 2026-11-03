#!/usr/bin/env bash
# Read-only: plan infra/terraform/bootstrap into bs.tfplan and print the change summary (no apply).
set -euo pipefail
export AWS_REGION=eu-north-1 AWS_DEFAULT_REGION=eu-north-1 MSYS_NO_PATHCONV=1
REPO=dimakatsomm/card-dispute
B=infra/terraform/bootstrap
cd "$(dirname "$0")"
want=$(gh variable get AWS_ACCOUNT_ID -R "$REPO")
have=$(aws sts get-caller-identity --query Account --output text)
[ "$want" = "$have" ] || { echo "STOP: AWS session is not the card-dispute account"; exit 1; }
# Terraform cannot read `aws login` sessions; pass the same short-lived credentials through the environment.
eval "$(aws configure export-credentials --format env)"
SUB=$(gh api "repos/$REPO/actions/oidc/customization/sub" --jq .sub_claim_prefix)
terraform -chdir=$B init -input=false -reconfigure \
  -backend-config="bucket=$(gh variable get TF_STATE_BUCKET -R "$REPO")" \
  -backend-config="kms_key_id=$(gh variable get TF_STATE_KMS_KEY_ARN -R "$REPO")" >/dev/null
terraform -chdir=$B plan -input=false -no-color -var="github_repo=$REPO" -var="github_oidc_subject_prefix=$SUB" -out=bs.tfplan \
  | grep -E "will be|must be|Plan:|No changes" | sed -E 's/[0-9]{12}/<acct>/g'
