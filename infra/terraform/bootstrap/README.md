# bootstrap (I-00)

Standalone root module, applied once by the owner with their own credentials (OWN-4). CI never applies it.
It creates:

| Resource | Notes |
|---|---|
| State bucket (`cd-tfstate-<account id>` unless `state_bucket_name` is set) | Versioned, SSE-KMS with its own key (bucket key on), TLS-only and KMS-only bucket policy, all four public access block flags, `BucketOwnerEnforced`, `prevent_destroy`. Noncurrent versions expire after 90 days, `plans/` after 30 days. |
| KMS key `alias/cd-tfstate` | Rotation on, `prevent_destroy`. Encrypts state, locks and stored plans. |
| OIDC provider `token.actions.githubusercontent.com` | Audience `sts.amazonaws.com`. No thumbprint: AWS trusts GitHub's certificate via its root CA library. |
| `gha-infra-plan` | Trusted only for `repo:<repo>:ref:refs/heads/main`. `ReadOnlyAccess` plus state read, lock and `plans/*` writes, the state key, and read access to `cd/*` secret values (which Terraform refresh reads; they are in state anyway). Denied seed-user secrets and evidence/quarantine object reads. |
| `gha-infra-apply` | Trusted only for `repo:<repo>:environment:dev`. `ReadOnlyAccess` for refresh, plus write actions limited to the services in `modules/README.md` and the `cd-` / `cd/` / `/cd/` names. Creating roles requires path `/cd/` and boundary `cd-workload-boundary`, and `iam:PassRole` is allowed only for `/cd/` roles. Requests outside af-south-1 and us-east-1 are denied, and so are changes to its own role, its own policies, the boundary, the OIDC provider, the state bucket and the state key. |
| `cd-workload-boundary` | Caps every `/cd/` role (workloads and CI roles) to ECS, ECR, Logs, S3, SQS, KMS, Secrets Manager, SES, Cognito admin, Lambda, EventBridge, ENIs and GuardDuty malware protection. Denies every IAM action except `iam:PassRole` (to ECS tasks, for `/cd/` roles only), denies `organizations:*`, and denies `sts:AssumeRole` outside `/cd/`. |

## OWN-4: apply, migrate state, publish outputs

Run this in Git Bash from the repository root, with SSO admin credentials for the dev account (af-south-1 enabled).

```bash
export AWS_PROFILE=<owner-sso-admin-profile>
aws sso login
aws sts get-caller-identity

B=infra/terraform/bootstrap
REPO=<owner>/<repo>

terraform -chdir=$B init
terraform -chdir=$B apply -var="github_repo=$REPO"

TF_STATE_BUCKET=$(terraform -chdir=$B output -raw state_bucket_name)
TF_STATE_KMS_KEY_ARN=$(terraform -chdir=$B output -raw state_kms_key_arn)
INFRA_PLAN_ROLE_ARN=$(terraform -chdir=$B output -raw infra_plan_role_arn)
INFRA_APPLY_ROLE_ARN=$(terraform -chdir=$B output -raw infra_apply_role_arn)
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

cp $B/backend.s3.tf.example $B/backend.tf
terraform -chdir=$B init -migrate-state \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="kms_key_id=$TF_STATE_KMS_KEY_ARN"
terraform -chdir=$B plan -var="github_repo=$REPO"
rm $B/terraform.tfstate $B/terraform.tfstate.backup
```

Answer `yes` when `init -migrate-state` asks to copy the state. The final `plan` must report `No changes`
before you delete the local state files. Commit `backend.tf` afterwards (the orchestrator commits).

Copy the outputs into the GitHub Environment `dev`:

```bash
for kv in AWS_REGION=af-south-1 AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID TF_STATE_BUCKET=$TF_STATE_BUCKET \
          TF_STATE_KMS_KEY_ARN=$TF_STATE_KMS_KEY_ARN AWS_INFRA_APPLY_ROLE_ARN=$INFRA_APPLY_ROLE_ARN; do
  gh variable set "${kv%%=*}" --env dev --body "${kv#*=}" --repo "$REPO"
done
```

The plan job must not declare `environment: dev`: if it did, its token's `sub` would be `environment:dev` and
`gha-infra-plan` would refuse it. Environment variables are therefore not visible to that job, so it also needs
these values as repository variables:

```bash
for kv in AWS_REGION=af-south-1 AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID TF_STATE_BUCKET=$TF_STATE_BUCKET \
          TF_STATE_KMS_KEY_ARN=$TF_STATE_KMS_KEY_ARN AWS_INFRA_PLAN_ROLE_ARN=$INFRA_PLAN_ROLE_ARN; do
  gh variable set "${kv%%=*}" --body "${kv#*=}" --repo "$REPO"
done
```

These are variables, not secrets. They identify resources but grant nothing, and CI masks them in logs (ADR-063).

## Using the state bucket from envs/dev

```bash
terraform -chdir=infra/terraform/envs/dev init \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="key=envs/dev/terraform.tfstate" \
  -backend-config="region=af-south-1" \
  -backend-config="kms_key_id=$TF_STATE_KMS_KEY_ARN"
```

Always pass `kms_key_id`. Without it, the S3 backend sends `AES256` and the bucket policy rejects the write.
The apply role can write state only under `envs/dev/`; the plan role can write only `envs/dev/*.tflock` and `plans/*`.

## Changing this module

Re-run `terraform -chdir=infra/terraform/bootstrap plan` and `apply` with owner credentials. If the apply role hits
`AccessDenied` for a resource a module needs, add the action here, scoped to the `cd-` name. Never widen it to `*`.

Offline checks:

```bash
terraform -chdir=infra/terraform/bootstrap fmt -check -recursive
terraform -chdir=infra/terraform/bootstrap init -backend=false
terraform -chdir=infra/terraform/bootstrap validate
terraform -chdir=infra/terraform/bootstrap test
```
