# Task for Codex: finish OWN-4 (bootstrap state migration + GitHub variables)

Repository: `dimakatsomm/card-dispute`. Read `AGENTS.md` first and follow it.
Work in the local clone where `terraform apply` was already run for `infra/terraform/bootstrap`
(it contains `infra/terraform/bootstrap/terraform.tfstate`). If that file is not there, stop and ask.

Reference: `docs/11-dev-runbook.md`, section "3. OWN-4 — bootstrap apply and state migration".

## Rules
- Use the owner's existing short-lived AWS session (`AWS_PROFILE`, region `eu-north-1`). Never create access keys.
- Do **not** run `terraform apply` or `destroy` anywhere. Do not touch `infra/terraform/envs/dev`.
- Never print or commit account ids, ARNs, state files or plan output into git. Outputs go only into GitHub variables.
- If any step's result differs from the "expect" line, stop and report the exact output.

## Steps (Git Bash)

```bash
export AWS_REGION=eu-north-1 AWS_DEFAULT_REGION=eu-north-1
export REPO=dimakatsomm/card-dispute B=infra/terraform/bootstrap
aws sts get-caller-identity --query Account --output text   # expect the account id stored in GitHub var AWS_ACCOUNT_ID
git pull --ff-only origin main

TF_STATE_BUCKET=$(terraform -chdir=$B output -raw state_bucket_name)
TF_STATE_KMS_KEY_ARN=$(terraform -chdir=$B output -raw state_kms_key_arn)
INFRA_PLAN_ROLE_ARN=$(terraform -chdir=$B output -raw infra_plan_role_arn)
INFRA_APPLY_ROLE_ARN=$(terraform -chdir=$B output -raw infra_apply_role_arn)

cp $B/backend.s3.tf.example $B/backend.tf
terraform -chdir=$B init -migrate-state -force-copy \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="kms_key_id=$TF_STATE_KMS_KEY_ARN"
terraform -chdir=$B plan -var="github_repo=$REPO" -detailed-exitcode   # expect exit 0 ("No changes")
```

Only if the plan exit code is 0:

```bash
rm -f $B/terraform.tfstate $B/terraform.tfstate.backup

for kv in TF_STATE_BUCKET=$TF_STATE_BUCKET TF_STATE_KMS_KEY_ARN=$TF_STATE_KMS_KEY_ARN \
          AWS_INFRA_PLAN_ROLE_ARN=$INFRA_PLAN_ROLE_ARN; do
  gh variable set "${kv%%=*}" --body "${kv#*=}" --repo "$REPO"
done
gh variable set AWS_INFRA_APPLY_ROLE_ARN --env dev-infra --body "$INFRA_APPLY_ROLE_ARN" --repo "$REPO"

git add $B/backend.tf
git commit -m "chore(infra): bootstrap remote state"
git push origin main
```

`backend.tf` holds no ids (bucket and key come from `-backend-config`). Check with `git diff --cached` before committing
that it is the only staged file.

## Report back
- `aws sts` account matched: yes/no
- migrate-state result, plan exit code
- the names (not values) of the variables set, and where (repo / `dev-infra`)
- the pushed commit SHA
