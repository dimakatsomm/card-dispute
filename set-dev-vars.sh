#!/usr/bin/env bash
# Runbook §4: read envs/dev outputs (read-only) and set the GitHub Environment `dev` variables. Prints names only.
set -euo pipefail
export AWS_REGION=eu-north-1 AWS_DEFAULT_REGION=eu-north-1
export PATH="/c/Users/DimakatsoMakgatho/AppData/Local/nvm/v26.3.1:$PATH"
REPO=dimakatsomm/card-dispute
ENV=infra/terraform/envs/dev
cd "$(dirname "$0")"

want=$(gh variable get AWS_ACCOUNT_ID -R "$REPO")
have=$(aws sts get-caller-identity --query Account --output text)
[ "$want" = "$have" ] || { echo "STOP: AWS session is not the card-dispute account"; exit 1; }
echo "account matches"
# Terraform cannot read `aws login` sessions; pass the same short-lived credentials through the environment.
eval "$(aws configure export-credentials --format env)"

export TF_DATA_DIR="$TEMP/tf-dev-outputs"
terraform -chdir=$ENV init -input=false -reconfigure \
  -backend-config="bucket=$(gh variable get TF_STATE_BUCKET -R "$REPO")" \
  -backend-config="key=envs/dev/terraform.tfstate" \
  -backend-config="region=eu-north-1" \
  -backend-config="kms_key_id=$(gh variable get TF_STATE_KMS_KEY_ARN -R "$REPO")" >/dev/null
echo "init ok"

out() { terraform -chdir=$ENV output -raw "$1"; }
net() { terraform -chdir=$ENV output -json dev_tools_run_task_network | node -e "const n=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log($1)"; }
set_var() {
  [ -n "$2" ] && [ "$2" != "null" ] || { echo "STOP: $1 is empty"; exit 1; }
  gh variable set "$1" --env dev --body "$2" --repo "$REPO" >/dev/null && echo "set $1"
}

set_var WEB_ORIGIN "$(out web_origin)"
set_var NAME_PREFIX cd
set_var COGNITO_USER_POOL_ID "$(out cognito_user_pool_id)"
set_var COGNITO_E2E_CLIENT_ID "$(out cognito_e2e_client_id)"
set_var QUARANTINE_BUCKET_NAME "$(out quarantine_bucket_name)"
set_var EVIDENCE_BUCKET_NAME "$(out evidence_bucket_name)"
set_var NOTIFICATIONS_QUEUE_URL "$(out notifications_queue_url)"
set_var SES_EVENTS_QUEUE_URL "$(out ses_events_queue_url)"
set_var DEV_TOOLS_SUBNET_IDS "$(net 'n.subnet_ids.join(",")')"
set_var DEV_TOOLS_SG_ID "$(net 'n.security_group_id')"
set_var DISPUTE_NOTIFIER_SG_ID "$(out dispute_notifier_security_group_id)"
echo "done"
