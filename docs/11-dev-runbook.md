# 11 — Dev runbook (eu-north-1, environment `dev`)

Ordered, copy-pasteable steps to take an empty AWS account to a running `dev`, plus the operations you will need
afterwards. Design background: docs/06 (infra), docs/09 (pipelines), docs/05 (security).

Conventions:
- Commands run in **Git Bash** from the repository root unless stated otherwise.
- `<angle brackets>` are values only you know. Everything else is literal.
- Workflow and pipeline names marked **(CI-02)** are specified in the backlog but not built yet. Check the exact
  workflow file and input names in `.github/workflows/` before running them, and fix this file if they differ.
- Nothing here puts a secret in git. Passwords, client secrets and the DB master secret stay in Secrets Manager.

Owner tasks covered: OWN-1 (step 1), OWN-3 (step 2), OWN-4 (step 3), OWN-5 (step 4), OWN-6 (step 10), OWN-7 (every
approval click in steps 4 to 11). OWN-2, the $200 budget, is already decided (ADR-063).

## Shell setup (every new terminal)

```bash
export AWS_PROFILE=<owner-sso-admin-profile>
export AWS_REGION=eu-north-1
export AWS_DEFAULT_REGION=eu-north-1
aws sso login

export REPO=<owner>/<repo>
# GitHub OIDC sub prefix: "repo:$REPO", or sub_claim_prefix when use_immutable_subject is true
export SUB=$(gh api repos/$REPO/actions/oidc/customization/sub --jq 'if .use_immutable_subject then .sub_claim_prefix else "repo:" + "'$REPO'" end')
export ENV=infra/terraform/envs/dev
export B=infra/terraform/bootstrap
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR=$AWS_ACCOUNT_ID.dkr.ecr.eu-north-1.amazonaws.com
export TF_STATE_BUCKET=cd-tfstate-$AWS_ACCOUNT_ID
export TF_STATE_KMS_KEY_ARN=$(aws kms describe-key --key-id alias/cd-tfstate --query KeyMetadata.Arn --output text 2>/dev/null)
```

`TF_STATE_BUCKET` and `TF_STATE_KMS_KEY_ARN` only resolve after step 3. Before then ignore their values.

## Cost and budget in one paragraph

A 24x7 `dev` costs about **$222/month** against the **$200** budget (docs/06). The budget sends email to
`dimakatsomm@icloud.com` at forecast 100% (expect it in week one), actual 80% ($160, about day 22) and actual 100%.
Those alerts are expected, not incidents. Use "Park and unpark" below to stay under $200 when `dev` is idle.

---

## 1. OWN-1 — AWS account, region, preflight

Do once, in the AWS console and CLI.

Use the **Paid plan** (ADR-069): the Free plan's AWS-managed SCP denies GuardDuty and IAM OIDC providers. Upgrade in
Billing and Cost Management ("Upgrade plan"; also "Activate advanced AWS features" if offered), then re-run the preflight below:
`guardduty list-detectors` and `iam list-open-id-connect-providers` must no longer fail with "explicit deny in a service control policy".
Credits still apply. Close the account after the presentation ("Teardown and account closure").

1. Root user: enable MFA, delete any root access keys, and stop using root.
2. Create an admin through IAM Identity Center (SSO) and `aws configure sso` for profile `<owner-sso-admin-profile>`.
   If Identity Center is not offered, create an IAM user with console access and MFA only (no access keys)
   and use `aws login --profile <owner-sso-admin-profile>` for short-lived CLI credentials.
   Use short-lived credentials only, no IAM user access keys.
3. Give that admin access to Billing (Billing and Cost Management, "IAM user and role access to Billing information").
4. Install Terraform >= 1.10, AWS CLI v2, `gh`, Docker and Node 24.

eu-north-1 is enabled by default (not an opt-in region). Check the tools:

```bash
terraform version        # >= 1.10
aws --version
gh --version && gh auth status
docker --version
node --version           # v24.x
```

Read-only preflight. **Paste the output of this block back to the orchestrator**; it settles the open V-M3 checks.

```bash
aws sts get-caller-identity

aws rds describe-orderable-db-instance-options --region eu-north-1 \
  --engine aurora-postgresql --db-instance-class db.serverless \
  --query "OrderableDBInstanceOptions[?starts_with(EngineVersion, '18.')].EngineVersion" --output text

aws sesv2 list-email-identities --region eu-north-1
aws guardduty list-detectors --region eu-north-1
aws scheduler list-schedule-groups --region eu-north-1 --query 'ScheduleGroups[].Name'

aws lambda get-account-settings --region eu-north-1 \
  --query '{ConcurrentExecutions:AccountLimit.ConcurrentExecutions,Unreserved:AccountLimit.UnreservedConcurrentExecutions}'

aws service-quotas get-service-quota --region eu-north-1 \
  --service-code fargate --quota-code L-3032A538 --query Quota.Value
```

Accept when:
- the Aurora query lists `18.3` or higher (an empty list means PG 18 is not orderable here: stop and report);
- the Fargate On-Demand vCPU quota is **>= 3** (request an increase otherwise);
- `UnreservedConcurrentExecutions` is not tiny (a new account may be low; the plan uses no reserved concurrency);
- the SES and GuardDuty calls return without `AccessDenied` or "not available in region". A GuardDuty refusal means evidence can never
  be scanned and promoted: stop and report.

## 2. OWN-3 — GitHub repository, settings, Environment `dev`

The repository is **public** (ADR-041), which is what makes Environment required reviewers available on the Free plan.

### 2.1 Create the repo and push `main`

```bash
gh repo create "$REPO" --public --source=. --remote=origin --push
```

The gitleaks check must pass on the pushed `main` (see the `repo-checks` workflow). If it fails, fix the finding
before going on; never allowlist a real secret.

Point Terraform at the real repo (the variable validation rejects the placeholder), then commit it:

```bash
sed -i "s#PLACEHOLDER/card-dispute#$REPO#" $ENV/dev.tfvars
git checkout -b chore/set-github-repo
git add $ENV/dev.tfvars
git commit -m "chore(infra): set github_repo"
git push -u origin chore/set-github-repo
gh pr create --fill
```

Merge that PR once `ci-gate` is green (branch protection below makes this the only way in, with admin bypass).

### 2.2 Security settings

```bash
gh api -X PATCH "repos/$REPO" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'

gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

In the web UI, **Settings > Actions > General > Fork pull request workflows from outside collaborators**: choose
"Require approval for all outside collaborators". (Use the UI; it is the one setting here with no stable CLI form.)

### 2.3 Branch protection on `main`

PR required, `ci-gate` required, **0 approvals**, admin bypass (`enforce_admins` false), no force-push (ADR-063):

```bash
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["ci-gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

### 2.4 Environment `dev`

Required reviewer = you, **prevent self-review OFF** (you are the only approver, so ON would block every deploy),
and deployment branches = `main` only. Never add `refs/pull/*/merge`: a PR job that references the Environment
would then present the `environment:dev` OIDC sub (V-M3 10c).

```bash
REVIEWER_ID=$(gh api users/<your-github-login> --jq .id)

gh api -X PUT "repos/$REPO/environments/dev" --input - <<JSON
{
  "reviewers": [ { "type": "User", "id": $REVIEWER_ID } ],
  "prevent_self_review": false,
  "can_admins_bypass": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON

gh api -X POST "repos/$REPO/environments/dev/deployment-branch-policies" -f name=main -f type=branch

gh api "repos/$REPO/environments/dev" --jq '{reviewers: [.protection_rules[]?.reviewers], prevent_self_review: (.protection_rules[]? | select(.type=="required_reviewers") | .prevent_self_review)}'
```

### 2.4b Environment `dev-infra` (infra apply only)

The `infra` workflow's apply job is the only job that uses `dev-infra`, and `gha-infra-apply` trusts only its sub
(`repo:<repo>:environment:dev-infra`). Keeping it apart from `dev` means approving an app deploy can never approve an
infra apply, and no deploy, tools or e2e job can present the apply role's sub.

Settings: required reviewer, **prevent self-review OFF** (single owner, 2026-10-27: with it ON nobody can approve), admins cannot bypass, deployment branches = `main` only
(never `refs/pull/*/merge`).

```bash
gh api -X PUT "repos/$REPO/environments/dev-infra" --input - <<JSON
{
  "reviewers": [ { "type": "User", "id": $REVIEWER_ID } ],
  "prevent_self_review": false,
  "can_admins_bypass": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON

gh api -X POST "repos/$REPO/environments/dev-infra/deployment-branch-policies" -f name=main -f type=branch

gh api "repos/$REPO/environments/dev-infra" --jq '{can_admins_bypass, rules: [.protection_rules[]? | {type, prevent_self_review, reviewers: [.reviewers[]?.reviewer.login]}]}'
gh api "repos/$REPO/environments/dev-infra/deployment-branch-policies" --jq '[.branch_policies[].name]'   # ["main"]
```

With a second reviewer, turn prevent self-review back ON: then whoever triggered the run (the person who merged to `main`, or who ran
`gh workflow run infra.yml`) cannot approve it. Add a second reviewer (another `{ "type": "User", "id": ... }` entry in `reviewers`) who approves infra applies. If
you are the only reviewer, CI cannot apply infra: use the local fallback in step 4 with your SSO admin credentials.

### 2.5 Variables: which go where

GitHub gives a job an Environment's variables only when the job declares that environment, and that changes its
OIDC `sub`. Repository variables are visible to every job, with or without an environment. So the shared values are
repository variables, and only the apply role ARN sits on `dev-infra` (set in step 3 once they exist):

| Scope | Used by jobs that | Variables |
|---|---|---|
| **Repository** variables | every job; the `infra` plan job and the publish jobs declare no environment (sub `ref:refs/heads/main`) | `AWS_REGION`, `AWS_ACCOUNT_ID`, `TF_STATE_BUCKET`, `TF_STATE_KMS_KEY_ARN`, `AWS_INFRA_PLAN_ROLE_ARN` |
| **Environment `dev-infra`** variables | declare `environment: dev-infra`: only the `infra` apply job (`gha-infra-apply`, sub `environment:dev-infra`) | `AWS_INFRA_APPLY_ROLE_ARN` |
| **Environment `dev`** variables | declare `environment: dev`: ECS and Lambda deploy roles, run-tools, e2e (sub `environment:dev`) | `WEB_ORIGIN` (Terraform output `web_origin`; enables the web health check after deploy), plus the values the dev-tools and e2e steps below set |

Do not set `TF_STATE_*` or `AWS_INFRA_*` on `dev`: no job there uses them. An Environment variable overrides a
repository variable of the same name, so never set a different `AWS_REGION` or `AWS_ACCOUNT_ID` on either Environment.

They are variables, not secrets: they name resources but grant nothing, and CI masks the account id, state bucket,
state key and role ARNs in logs (ADR-063).

## 3. OWN-4 — bootstrap apply and state migration

Applied once, by you, with your SSO admin credentials. CI never applies `bootstrap/`. It creates the state bucket,
the KMS key `alias/cd-tfstate`, the GitHub OIDC provider, `gha-infra-plan`, `gha-infra-apply` and the permissions
boundary `cd-workload-boundary`.

```bash
aws sts get-caller-identity

terraform -chdir=$B init
terraform -chdir=$B apply -var="github_repo=$REPO" -var="github_oidc_subject_prefix=$SUB"

TF_STATE_BUCKET=$(terraform -chdir=$B output -raw state_bucket_name)
TF_STATE_KMS_KEY_ARN=$(terraform -chdir=$B output -raw state_kms_key_arn)
INFRA_PLAN_ROLE_ARN=$(terraform -chdir=$B output -raw infra_plan_role_arn)
INFRA_APPLY_ROLE_ARN=$(terraform -chdir=$B output -raw infra_apply_role_arn)

cp $B/backend.s3.tf.example $B/backend.tf
terraform -chdir=$B init -migrate-state \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="kms_key_id=$TF_STATE_KMS_KEY_ARN"
terraform -chdir=$B plan -var="github_repo=$REPO" -var="github_oidc_subject_prefix=$SUB"
```

Answer `yes` when `init -migrate-state` offers to copy the state. **Always pass `kms_key_id`**: without it the S3
backend sends `AES256` and the bucket policy rejects the write. The final `plan` must say `No changes`. Only then:

```bash
rm $B/terraform.tfstate $B/terraform.tfstate.backup
git add $B/backend.tf && git commit -m "chore(infra): bootstrap remote state" && git push
```

(Push through a PR if branch protection stops the direct push; admin bypass allows it.)

Publish the outputs (step 2.5 explains the split). Repository variables:

```bash
for kv in AWS_REGION=eu-north-1 AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID TF_STATE_BUCKET=$TF_STATE_BUCKET \
          TF_STATE_KMS_KEY_ARN=$TF_STATE_KMS_KEY_ARN AWS_INFRA_PLAN_ROLE_ARN=$INFRA_PLAN_ROLE_ARN; do
  gh variable set "${kv%%=*}" --body "${kv#*=}" --repo "$REPO"
done
```

The apply role ARN, on Environment `dev-infra` only:

```bash
gh variable set AWS_INFRA_APPLY_ROLE_ARN --env dev-infra --body "$INFRA_APPLY_ROLE_ARN" --repo "$REPO"
gh variable list --env dev-infra --repo "$REPO"
```

If you published variables with an earlier version of this step, remove the copies from `dev`:
`for v in TF_STATE_BUCKET TF_STATE_KMS_KEY_ARN AWS_INFRA_APPLY_ROLE_ARN; do gh variable delete "$v" --env dev --repo "$REPO"; done`

### 3.1 Re-apply bootstrap after a trust change

`gha-infra-apply` trusts `repo:<repo>:environment:dev-infra` (it trusted `environment:dev` before CI-02d). CI never
applies `bootstrap/`, so if you applied bootstrap before that change, re-apply it yourself before the first CI
infra apply; until then the apply job fails at `AssumeRoleWithWebIdentity`:

```bash
terraform -chdir=$B init \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="kms_key_id=$TF_STATE_KMS_KEY_ARN"
terraform -chdir=$B plan -var="github_repo=$REPO" -var="github_oidc_subject_prefix=$SUB" -out="$TEMP/bootstrap.tfplan"
```

The plan must show exactly one in-place update: `aws_iam_role.infra_apply` (`assume_role_policy`, sub
`environment:dev` to `environment:dev-infra`). Anything else, stop and ask. Then:

```bash
terraform -chdir=$B apply "$TEMP/bootstrap.tfplan"
rm "$TEMP/bootstrap.tfplan"
aws iam get-role --role-name gha-infra-apply \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals' --output json   # sub ends in environment:dev-infra
```

Initialise the `dev` root against the new backend (you need this for local `terraform` commands later):

```bash
terraform -chdir=$ENV init \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="key=envs/dev/terraform.tfstate" \
  -backend-config="region=eu-north-1" \
  -backend-config="kms_key_id=$TF_STATE_KMS_KEY_ARN"
```

## 4. Infra apply, phase A (no Lambdas, services at count 0)

Phase A builds everything that does not need an image. `lambda_image_uris` stays `{}`, so no Lambda **function**
exists yet, but the Lambda roles, log groups and the sweeper scheduler role do (ADR-066), so the queue and bucket
policies can name real role ARNs. All five ECS services are created at `desired_count` 0 and
`enable_service_autoscaling` stays `false`, so nothing needs an image and nothing is billed for tasks.

Run it through the pipeline (ADR-060). `infra.yml` runs on every push to `main` that touches `infra/terraform/**`,
or on dispatch:
1. `verify`: `fmt -check`, `validate` and `terraform test` for every module, `bootstrap` and `envs/dev`, then tflint
   and checkov. No AWS access (this is also all a PR runs).
2. `plan` (`gha-infra-plan`, no environment): `terraform plan -out`, upload to
   `s3://<state bucket>/plans/<git-sha>/<run-attempt>.tfplan` with SSE-KMS (state key), and record the S3
   `VersionId` and the file's sha256 as job outputs. The log and the run summary show only change counts and the
   addresses of destroys and replacements; plan text and the plan file are never printed or uploaded as an artifact.
   No changes means no upload and no apply job.
3. `apply` (`gha-infra-apply`, Environment `dev-infra`): waits for approval, downloads exactly that `VersionId`,
   refuses it unless the sha256 matches, applies it, then puts a delete marker on the object (the `plans/` lifecycle
   expires the version a day later). Resource ids and Terraform outputs are stripped from the log.

Runs share the concurrency group `infra` and are never cancelled: a second run waits until the first finishes
(including its approval wait). Reject a pending approval to release the queue. If several runs queue, GitHub
keeps only the newest pending one.

```bash
gh workflow run infra.yml --ref main --repo "$REPO"
gh run watch --repo "$REPO"                           # pick the infra run
```

Open the run in the Actions tab, read the plan job's summary (check every `delete` and `replace` line), then
**Review deployments > dev-infra > Approve** (step 2.4b: a reviewer other than whoever triggered the run).
A rerun of only the apply job reuses the approved plan; if the state changed since the plan, Terraform rejects it as
stale and you re-run the whole workflow.

If CI cannot apply (no second reviewer, or the pipeline is broken), the owner fallback is the same plan applied
locally with your SSO admin credentials. This is a **break-glass admin apply**: it skips the `gha-infra-apply`
guardrails (permissions boundary, `/cd/` path rule, deny list, region deny) and the stored-plan hash pin, so plan only
from a clean checkout of `origin/main` (`git status` empty, `git rev-parse HEAD` equal to `origin/main`) and read every
`delete` and `replace` line before you apply. With a single reviewer this is the normal infra path; adding a second
reviewer to `dev-infra` moves applies back to the scoped CI role.

```bash
git fetch origin && git status --short && test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
terraform -chdir=$ENV plan -var-file=dev.tfvars -out="$TEMP/phase-a.tfplan"
terraform -chdir=$ENV apply "$TEMP/phase-a.tfplan"
rm "$TEMP/phase-a.tfplan"        # plans can contain secrets; never commit or upload one
```

What to expect:
- **CloudFront VPC origin takes up to 15 minutes** to reach `Deployed`. Order is fixed: ALB active, then VPC origin,
  then the ALB SG ingress from `CloudFront-VPCOrigins-Service-SG`. If the SG-rule step fails on the first run
  because the service SG does not exist yet, run the apply again once the origin is `Deployed`.
- **ECS service-linked role.** In a new account `CreateCluster` can fail with "ECS Service Linked Role is not ready"
  (seen 2026-10-27). Create it once before phase A, then dispatch a fresh plan (the stored plan is stale after a
  partial apply): `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com`
- **OWN-5.** If the GuardDuty malware-protection plan errors because GuardDuty was never enabled in the account, enable it once and re-apply:
  `aws guardduty create-detector --enable --region eu-north-1`
- If `gha-infra-apply` returns `AccessDenied` for an action a module needs, add that action to
  `infra/terraform/bootstrap`, scoped to the `cd-` name (never `*`), re-run step 3's `apply` with your own
  credentials, then retry (docs: `infra/terraform/bootstrap/README.md`).
- SES and SNS each send a confirmation email now (step 10).

The publish, deploy, run-tools and e2e workflows build their role ARNs from `AWS_ACCOUNT_ID` and the fixed names
(`arn:aws:iam::<account>:role/cd/cd-gha-<key>`, keys as in the `ci_role_arns` output), so no per-role variable is needed.
Set the Environment `dev` variables the deploy, dev-tools and e2e workflows read, once phase A has applied:

```bash
out() { terraform -chdir=$ENV output -raw "$1"; }
net() { terraform -chdir=$ENV output -json dev_tools_run_task_network | jq -r "$1"; }
for kv in \
  WEB_ORIGIN="$(out web_origin)" \
  NAME_PREFIX=cd \
  COGNITO_USER_POOL_ID="$(out cognito_user_pool_id)" \
  COGNITO_E2E_CLIENT_ID="$(out cognito_e2e_client_id)" \
  QUARANTINE_BUCKET_NAME="$(out quarantine_bucket_name)" \
  EVIDENCE_BUCKET_NAME="$(out evidence_bucket_name)" \
  NOTIFICATIONS_QUEUE_URL="$(out notifications_queue_url)" \
  SES_EVENTS_QUEUE_URL="$(out ses_events_queue_url)" \
  DEV_TOOLS_SUBNET_IDS="$(net '.subnet_ids | join(",")')" \
  DEV_TOOLS_SG_ID="$(net .security_group_id)" \
  DISPUTE_NOTIFIER_SG_ID="$(out dispute_notifier_security_group_id)"; do
  gh variable set "${kv%%=*}" --env dev --body "${kv#*=}" --repo "$REPO"
done
```

Check phase A:

```bash
aws ecs list-services --cluster $(aws ecs list-clusters --query 'clusterArns[0]' --output text)
aws ecr describe-repositories --query 'repositories[].repositoryName' --output text     # nine cd-* repos
aws cloudfront list-distributions --query 'DistributionList.Items[].DomainName' --output text
aws rds describe-db-clusters --query 'DBClusters[].[DBClusterIdentifier,Status,ServerlessV2ScalingConfiguration]'
```

All five services exist with `desiredCount` 0. Aurora is `available` with no application roles yet (step 7).

### First apply checks

Several behaviours could only be assumed when the modules were written. On the first real apply, check each one;
paths are under `infra/terraform/`.

| Check | What to look for | If it fails, change |
|---|---|---|
| VPC-origin SG | `aws ec2 describe-security-groups --filters Name=group-name,Values=CloudFront-VPCOrigins-Service-SG` returns a group once the VPC origin exists | `modules/edge` (SG lookup and ingress rule); re-apply after the origin is `Deployed` |
| GuardDuty malware plan | The malware-protection plan for the quarantine bucket is created (OWN-5 covers a missing detector) | `bootstrap/apply_policies.tf` (guardduty actions); `bootstrap/boundary.tf` if the plan's role is refused |
| Aurora PG 18.3 | `aws rds describe-orderable-db-instance-options --engine aurora-postgresql --engine-version 18.3 --db-instance-class db.serverless --region eu-north-1` is non-empty | `modules/aurora` (engine version); pick the nearest orderable 18.x |
| Performance Insights key | The cluster accepts the `cd-data` key for Performance Insights | `modules/aurora` (`performance_insights_kms_key_id`); `bootstrap/apply_policies.tf` if `AccessDenied` on `pi:*` or `kms:` |
| `wait function-updated-v2` | A deploy-lambda role can run `aws lambda wait function-updated-v2` (polls `GetFunction`, which the role has) | `modules/ci-roles` (deploy-lambda policy) |
| ECS run-task with tags | `aws ecs run-task --tags ...` from `run-tools` is not refused; tagging at launch needs `ecs:TagResource` | `modules/ci-roles` (run-tools policy) |
| Reachability Analyzer | The `gha-e2e` role can start and read an analysis; it may also need `tiros:*` actions | `modules/ci-roles` (e2e policy) |
| Managed-rule ARN forms | GuardDuty and WAF managed-rule resources are accepted by the apply role's resource ARNs | `bootstrap/apply_policies.tf` |
| VPC flow logs, if enabled | `gha-infra-apply` can `ec2:CreateFlowLogs` and `ec2:DeleteFlowLogs`, and `iam:PassRole` to `vpc-flow-logs.amazonaws.com` | `bootstrap/apply_policies.tf`; `bootstrap/boundary.tf` if the flow-log role is refused |

Fix the policy, re-run step 3's `apply` with your own credentials when the change is in `bootstrap/`, then retry.

## 5. Publish all nine images

Images are tagged with the **full git SHA** (immutable tags). Publish runs on `main` with the publish roles and needs
no approval; the deploy jobs that follow do. Nine images: `svc-auth`, `svc-users`, `svc-transactions`,
`svc-disputes`, `web`, `lambda-evidence-intake`, `lambda-dispute-notifier`, `lambda-retention-sweeper`, `dev-tools`.

```bash
git checkout main && git pull
export SHA=$(git rev-parse HEAD)

for wf in svc-auth svc-users svc-transactions svc-disputes web \
          lambda-evidence-intake lambda-dispute-notifier lambda-retention-sweeper; do
  gh workflow run "$wf.yml" --ref main --repo "$REPO"        # (CI-02) publish stage
done
gh workflow run dev-tools.yml --ref main --repo "$REPO"      # (CI-02) publishes the dev-tools image
```

Each service, web and Lambda run publishes, then its deploy job waits at the `dev` approval. **Do not approve those
yet**: the database is not ready (step 7). Leave them waiting, or cancel them and dispatch the deploy later with this
`SHA` (step 8 and "Redeploy after a config-only change").

Confirm all nine tags exist:

```bash
for r in svc-auth svc-users svc-transactions svc-disputes web \
         lambda-evidence-intake lambda-dispute-notifier lambda-retention-sweeper dev-tools; do
  printf '%s: ' "cd-$r"
  aws ecr describe-images --repository-name "cd-$r" --image-ids imageTag="$SHA" \
    --query 'imageDetails[0].imageTags' --output text
done
```

Every line must print the tag. If a path filter skipped a workflow for this commit, the dispatch above still builds it.

## 6. Infra apply, phase B (create the Lambdas)

Phase B passes the three published Lambda image URIs. Terraform then creates the functions, the alias `live`, the SQS
event source mapping, the EventBridge rule target for evidence-intake and the nightly schedule. This is also the first
proof that arm64 container-image Lambdas work in eu-north-1 (R-2).

```bash
gh workflow run infra.yml --ref main --repo "$REPO" -f lambda_image_uris="{\"evidence-intake\":\"$ECR/cd-lambda-evidence-intake:$SHA\",\"dispute-notifier\":\"$ECR/cd-lambda-dispute-notifier:$SHA\",\"retention-sweeper\":\"$ECR/cd-lambda-retention-sweeper:$SHA\"}"
```

The plan job rejects the input before touching AWS unless it is a JSON object with exactly these three keys, each
`<AWS_ACCOUNT_ID>.dkr.ecr.eu-north-1.amazonaws.com/cd-lambda-<key>:<40-hex sha>`. All three are required because the
input replaces the whole `dev.tfvars` map, so an omitted key would destroy that function.

Read the plan summary in the run (only creates and updates of the Lambda-dependent resources; no destroys), then approve
under **Review deployments > dev-infra**. Local fallback: add `-var='lambda_image_uris={...}'` to the step 4 plan command.

**Keep the Lambdas afterwards.** A function exists only while its key is in `lambda_image_uris`, so a later push-triggered
plan with the empty default would plan to **destroy** them. After phase B, put the same map in `dev.tfvars` through
a PR (`image_uri` is ignored after creation, so these URIs only need to stay valid; the deploy pipeline owns the code).
Always read the plan summary for `delete` and `replace` lines before approving any infra run.

```bash
for k in evidence-intake dispute-notifier retention-sweeper; do
  aws lambda get-function --function-name "cd-$k" \
    --query 'Configuration.[FunctionName,PackageType,Architectures[0],State]' --output text
done
```

Expect `Image arm64 Active` for each. Then let the Lambda pipelines deploy on push and dispatch (they skip the deploy job until this is set):

```bash
gh variable set LAMBDAS_DEPLOYED --body true --repo "$REPO"
```

## 7. dev-tools `db-bootstrap`

Creates the database schemas and the nine roles (`auth`, `users`, `transactions`, `disputes` each with `_migrator`
and `_app`, plus `disputes_retention`) using the RDS-managed master secret, with `verify-full` TLS. It sets the role passwords from
the nine `cd/dev/db/<role>` secrets and re-sets them on every run, so it is safe to repeat.

```bash
gh workflow run dev-tools.yml --ref main --repo "$REPO" -f task=db-bootstrap     # (CI-02) approve under dev
```

Approve the run under **Review deployments > dev**, then read the task log:

```bash
aws logs tail /cd/dev/tools/db-bootstrap --since 30m --format short
```

Success is a clean exit with no value printed (the task never logs passwords or the URL). A message naming
`DB_ADMIN_*` variables means the task could not read the master secret.

## 8. Deploy the services, migrations first

Order matters: **auth, users, transactions, disputes, web**. Every other service calls auth, and transactions and
disputes call users. Each deploy workflow does, in order: swap the image into a new task-definition revision,
**run the one-off `cd-<svc>-migrate` task** (a failed migration stops the deploy and the old tasks keep running; web has no
migration), update the service (desired count 1 only when it is 0), wait for stable and check health. ECS
rolls back automatically through the deployment circuit breaker.

```bash
for wf in svc-auth svc-users svc-transactions svc-disputes web; do
  gh workflow run "$wf.yml" --ref main --repo "$REPO" -f sha="$SHA"     # (CI-02) deploy with an explicit sha
  echo "Approve $wf under Review deployments > dev, wait for the run to finish, then continue."
  read -r -p "Press Enter when $wf is green: "
done
```

(Or approve the already-waiting runs from step 5, one at a time and in this order.) Check after each:

```bash
CLUSTER=$(aws ecs list-clusters --query 'clusterArns[0]' --output text)
aws ecs describe-services --cluster "$CLUSTER" --services cd-auth cd-users cd-transactions cd-disputes cd-web \
  --query 'services[].[serviceName,desiredCount,runningCount,deployments[0].rolloutState]' --output text
```

Each service must show `1 1 COMPLETED`. If one does not, see the alarm table's "unhealthy hosts" entry and the
service log group `/cd/dev/ecs/<svc>`.

Then deploy the Lambdas the same way (alias `live` is moved to the new version; these runs also need approval):

```bash
for wf in lambda-evidence-intake lambda-dispute-notifier lambda-retention-sweeper; do
  gh workflow run "$wf.yml" --ref main --repo "$REPO" -f sha="$SHA"     # (CI-02)
done
```

Leave `enable_service_autoscaling = false` (the default). If you turn it on, parking no longer sticks, because
autoscaling restores the minimum of 1 task (see "Park and unpark").

## 9. dev-seed

Creates Cognito users A to D (D disabled) idempotently with random passwords stored under
`cd/dev/seed-users/<username>`, and the matching `auth_identity.cognito_sub` rows from the real subs. A second run
changes nothing. User A gets at least 60 disputable transactions.

```bash
gh workflow run dev-tools.yml --ref main --repo "$REPO" -f tool=dev-seed         # (CI-02) approve under dev
aws logs tail /cd/dev/tools/dev-seed --since 30m --format short
```

**User A's email (`SEED_A_EMAIL`).** By default every user gets a generated `@example.com` address, and the e2e
SES delivery check skips because the SES sandbox only delivers to verified identities. To run that check, set
`SEED_A_EMAIL` to the SES-verified owner identity from step 10 (OWN-6). The seed then writes it to user A's
`app_user.email` and to A's Cognito `email` attribute (marked verified). It is validated as a plausible address and
never logged: the log line shows only `emailA: "custom"` or `"generated"`. A re-run with the same value changes 0 rows.
Changing or unsetting it on a later run updates both places again (unset restores the generated address).

The address reaches the task as a container environment override on the dev-seed run. Store it as the GitHub
environment **secret** `SEED_A_EMAIL` under Settings > Environments > dev, not as a variable or a workflow input: it is
real personal data and this repository is public (ADR-041). `dev-tools.yml` passes it only to dev-seed, and the
dev-seed role can update an existing user's address. The override value is visible in CloudTrail `RunTask` records
and `DescribeTasks` output inside the account.

```bash
gh secret set SEED_A_EMAIL --env dev --repo "$REPO"        # prompts for the value; never put it on the command line
```

Rerunning is safe. Disputes are permanent (one per transaction, ever), so seeded data is consumed over time; the
e2e uses at most 3 transactions per run, which gives roughly 20 runs for user A.

## 10. OWN-6 — SES and SNS confirmation clicks

Two emails arrive at `dimakatsomm@icloud.com` after phase A (check spam):
1. **Amazon SES** "Email Address Verification Request" for `dimakatsomm@icloud.com` in eu-north-1. The link expires after **24 hours**.
2. **AWS Notifications** "Subscription Confirmation" for the SNS topic `cd-alarms`. The link is valid for 3 days.

Click both. If the SES link expired, delete and re-create the identity (`aws sesv2 delete-email-identity --email-identity dimakatsomm@icloud.com --region eu-north-1`, then re-run the infra apply) and click the new one. If you would rather not wait for step 10, you can click both as soon as they arrive.

```bash
aws sesv2 get-email-identity --email-identity dimakatsomm@icloud.com --region eu-north-1 \
  --query VerifiedForSendingStatus                                   # true

TOPIC=$(aws sns list-topics --query "Topics[?contains(TopicArn,':cd-alarms')].TopicArn" --output text)
aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" \
  --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output text
```

The SES status must be `true`, and the SNS `SubscriptionArn` must be an ARN, not `PendingConfirmation`. Until then
notification mail fails with `MessageRejected` and no alarm reaches you. The account is in the SES sandbox
(200 messages a day, 1 a second, verified recipients only); the owner address is the only recipient.

## 11. e2e-dev

Runs the M1 and M2 flows against the deployed `dev`: API checks (including service-only paths returning 404 through
CloudFront and the real-S3 evidence controls), the net-probe task, the Playwright login as user A, and the
ses-events delivery checks.

```bash
gh workflow run e2e-dev.yml --ref main --repo "$REPO"                           # (CI-02) approve under dev
gh run watch --repo "$REPO"
```

Open the app at `https://<distribution domain>` (`terraform -chdir=$ENV output` prints it; also the CloudFront
console). The e2e uses the `e2e` Cognito client through IAM-signed `AdminInitiateAuth` (ADR-062), never a stored
user password. The net-probe task runs twice, from the dev-tools SG and from the dispute-notifier SG (ADR-067).

OWN-7, after the first real status-change mail: open it in your mail client, copy the full headers
(`Authentication-Results`, DMARC result) and paste them back. This closes V-05 and R-6 (SES cannot DKIM-sign for
`icloud.com`, so DMARC alignment may fail and the mail may land in spam; that is accepted for dev).

---

## Park and unpark

Why: services parked at count 0 save about $29/month if idle 60% of the time, and Aurora at minimum 0 ACU saves up to
$55 more while idle. NAT, the ALB, WAF, Secrets Manager and KMS keep billing (about $90/month), and Aurora keeps its storage.

### Park
1. Make sure nothing is deploying or running e2e. Make sure `enable_service_autoscaling` is `false` (it restores the minimum of 1 task otherwise).
2. Set all five services to zero tasks:

```bash
CLUSTER=$(aws ecs list-clusters --query 'clusterArns[0]' --output text)
for s in auth users transactions disputes web; do
  aws ecs update-service --cluster "$CLUSTER" --service "cd-$s" --desired-count 0 --query 'service.serviceName' --output text
done
aws ecs wait services-stable --cluster "$CLUSTER" --services cd-auth cd-users cd-transactions cd-disputes cd-web
```

3. Optional, for parks longer than a few days: let Aurora pause. Through a PR set `aurora_min_acu = 0` in
   `infra/terraform/envs/dev/dev.tfvars`, merge, and approve the infra apply. Aurora then pauses after its idle timeout
   (about 5 minutes) once no connection is open, and resumes on the first connection (the first query waits
   roughly 15 seconds). If the apply is rejected with an invalid minimum capacity, PG 18 does not accept 0 in eu-north-1
   (unconfirmed in V-M3): revert to `0.5` and rely on step 2 only.

Parking leaves the Lambdas in place. The nightly retention-sweeper (02:00 Africa/Johannesburg) connects to the
database, so it wakes a paused Aurora for a few minutes each night; that is a few cents, but it means "paused" is not
continuous. Expect ALB, health and unhealthy-host alarms to fire while the services are at 0; they are noise during a
park.

### Unpark
1. If you lowered it, restore `aurora_min_acu = 0.5` through a PR and approve the apply (or just let the first connection resume it).
2. Start the services in dependency order and wait:

```bash
CLUSTER=$(aws ecs list-clusters --query 'clusterArns[0]' --output text)
for s in auth users transactions disputes web; do
  aws ecs update-service --cluster "$CLUSTER" --service "cd-$s" --desired-count 1 --query 'service.serviceName' --output text
done
aws ecs wait services-stable --cluster "$CLUSTER" --services cd-auth cd-users cd-transactions cd-disputes cd-web
```

3. Check the target groups are healthy (`/ready` on 8080), then open the app. If a service stays unhealthy, the database is probably still resuming; wait a minute and re-check before debugging.

Unpark before an e2e run, and re-park afterwards. Deploy pipelines also move a service from 0 to 1 (only when it is 0),
so a deploy to a parked service starts it.

## Teardown and account closure (OWN-8, after the presentation)

The account exists only for the presentation (ADR-069). Destroy first so billing stops at once, then close the account.

1. In `dev.tfvars` set `deletion_protection = false`, then apply locally (break-glass). Destroy leaves the
   `cd-aurora-final` snapshot; delete it in the RDS console or let account closure remove it.
2. Empty the quarantine and evidence buckets (all versions), then destroy the environment:

   ```bash
   terraform -chdir=$ENV destroy -var-file=dev.tfvars
   ```

3. Leave `bootstrap/` (its `prevent_destroy` state bucket and KMS key cost cents); account closure removes it.
4. Billing and Cost Management: check no running charges in Cost Explorer for today.
5. Account (top-right menu) > **Close account**. AWS keeps the account suspended for 90 days, then deletes everything.
6. On GitHub delete the repository variables `AWS_ACCOUNT_ID`, `AWS_INFRA_PLAN_ROLE_ARN`, `TF_STATE_*` and the
   `dev` / `dev-infra` environment variables so no pipeline targets a closed account.

## Redeploy after a config-only Terraform change

`ignore_changes = [task_definition, desired_count]` means a Terraform change to a service's environment variables,
secrets or similar edits the task definition Terraform manages, but running tasks keep the old one. Roll it out by
re-running the service's deploy workflow on the sha that is already running. The workflow takes the latest
task-definition revision (which carries the new config) and swaps in that image.

```bash
CLUSTER=$(aws ecs list-clusters --query 'clusterArns[0]' --output text)
TD=$(aws ecs describe-services --cluster "$CLUSTER" --services cd-users --query 'services[0].taskDefinition' --output text)
RUNNING_SHA=$(aws ecs describe-task-definition --task-definition "$TD" \
  --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*://')

gh workflow run svc-users.yml --ref main --repo "$REPO" -f sha="$RUNNING_SHA"     # (CI-02) approve under dev
```

Replace `users` for the service you changed. The run also executes the migrate task, which is a no-op when nothing
is pending. Lambda configuration changed in Terraform applies to the function directly (only `image_uri` is
ignored), so Lambdas need no redeploy.

## Redrive a dead-letter queue from the console

Fix the cause first (read the failing Lambda's log), then redrive. Redrive needs the console role to match
`redrive_operator_arns` in the messaging module (your SSO admin permission set); it will not work from other principals.

**`cd-dispute-notifications-dlq`** (notification emails that failed 5 times):
1. AWS Console, region **Europe (Stockholm)**, then **SQS** > `cd-dispute-notifications-dlq`.
2. Click **Start DLQ redrive**.
3. Choose **Redrive to source queue** (`cd-dispute-notifications`), keep the default velocity, click **DLQ redrive**.
4. Watch **Message movement status** until it finishes; the DLQ depth returns to 0 and the alarm clears.

The notifier tolerates duplicates, so repeating a redrive is safe. The timeline in the database is the truth; a
lost email never changes dispute state.

**`cd-evidence-intake-dlq`** and **`cd-retention-scheduler-dlq`** have no source queue (they receive EventBridge and
Scheduler delivery failures and Lambda async failure records), so "redrive to source" does not exist. Instead:
1. SQS > the queue > **Send and receive messages** > **Poll for messages**, open a message and read it.
2. Intake: the body is the GuardDuty scan-result event (for async failures it is wrapped; the event is under `requestPayload`). Save the event as `event.json` and replay it; intake is idempotent:
   `aws lambda invoke --function-name cd-evidence-intake --qualifier live --cli-binary-format raw-in-base64-out --payload fileb://event.json out.json`
3. Retention: re-run the sweeper (it is idempotent): `aws lambda invoke --function-name cd-retention-sweeper --qualifier live out.json`
4. After a successful replay, **Purge** the queue (or delete the single message) so the alarm clears.

## Alarms: what each means and what to check first

Alarms and the dashboard `cd-dev` are in CloudWatch (region eu-north-1); alarm emails come from the SNS topic
`cd-alarms` to `dimakatsomm@icloud.com`. Log groups: ECS `/cd/dev/ecs/<svc>`, Lambda `/aws/lambda/cd-<key>`,
tools `/cd/dev/tools/<task>`. Tail one with `aws logs tail <group> --since 30m --format short`.

| Alarm | Means | First check |
|---|---|---|
| DLQ depth >= 1: `cd-dispute-notifications-dlq` | A status-change email failed 5 times | `/aws/lambda/cd-dispute-notifier` errors: SES `MessageRejected` (identity unverified, step 10), a users `:8081` or token failure, or a recipient not verified (sandbox). Fix, then redrive |
| DLQ depth >= 1: `cd-evidence-intake-dlq` | The scan-result event or an intake run failed after retries | `/aws/lambda/cd-evidence-intake`; then GuardDuty plan status and the EventBridge rule. Until it is replayed the evidence stays `PENDING` and the 1-day quarantine lifecycle will delete the object |
| DLQ depth >= 1: `cd-retention-scheduler-dlq` | The nightly sweeper could not be invoked | The schedule `cd-retention-sweeper` in EventBridge Scheduler and the function's state; re-invoke by hand |
| Lambda errors / throttles | A function raised or hit the concurrency limit | The function's log group; for throttles `aws lambda get-account-settings` (new-account concurrency quota) |
| `RetentionFailed` | The sweeper failed to expire or erase rows | `/aws/lambda/cd-retention-sweeper` and the Aurora connection (`DB_SSL`, `disputes_retention` secret) |
| `EventPublishFailed` | disputes committed a change but could not publish its SQS event, so that email will not be sent (best-effort, ADR-033) | `/cd/dev/ecs/disputes` for the failing `eventType`: the disputes task role's `sqs:SendMessage` and the KMS key `cd-data`. The dispute state is intact |
| `EvidenceNotScanned` | Evidence reached intake with no GuardDuty verdict | GuardDuty malware protection plan status for the quarantine bucket and the object tag `GuardDutyMalwareScanStatus`; with `EVIDENCE_REQUIRE_SCAN=true` the item is rejected rather than stored |
| `EvidenceResultConflict` | disputes refused intake's scan result because the evidence was already in another state | The dispute timeline and the `disputes` log for the evidence id; usually a replay after a decision, and harmless |
| ALB 5xx | The services returned 5xx through the ALB | `/cd/dev/ecs/<svc>` for the service behind the failing path; then Aurora (below) |
| ALB p95 > 1 s | Slow responses | `/cd/dev/ecs/<svc>` latency, Aurora capacity, and whether the Service Connect proxy is throttling the 0.25 vCPU task (resize that service only, ADR-065) |
| Unhealthy hosts | ALB target health (`/ready`) is failing | `aws elbv2 describe-target-health` on the target group; a failing `/ready` usually means the database is paused or unreachable. Expected while parked |
| Aurora at max ACU for 15 min | The database is saturated at 2 ACU | Slow queries in the `disputes` Aurora log export and connection counts (`DB_POOL_MAX=5` x tasks); raise `aurora_max_acu` only after finding the cause |
| Budget forecast 100% / actual 80% / 100% | Spend is tracking over $200 | Expected at 24x7 (about $222). Park (above) rather than treating it as an incident; check Cost Explorer for an unexpected line (NAT data, a second task, Service Connect resize) |

M4 (H-02) turns these first checks into full per-alarm runbooks.
