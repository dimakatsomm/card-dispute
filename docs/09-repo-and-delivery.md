# 09 — Repository, Containers & Pipelines

Owner decisions 2026-10-11:
- Monorepo split into `backend/` (Node 24), `frontend/` (React) and `infra/` (Terraform).
- Each microservice gets its own folder.
- Everything ships as a container: services, frontend **and Lambdas**.
- One GitHub Actions pipeline per deployable.
- **Every deploy needs manual approval.**

(ADR-029…032)

---

## 1. Repository layout

```
/
├── backend/                         Node.js 24, TypeScript — pnpm workspace members
│   ├── auth/                        microservice
│   │   ├── src/                     app, routes (public.ts / service.ts), repo, config
│   │   ├── migrations/              SQL for schema `auth`
│   │   ├── test/                    unit + integration (testcontainers)
│   │   ├── Dockerfile
│   │   └── package.json             @cd/auth
│   ├── users/                       same shape — @cd/users
│   ├── transactions/                same shape — @cd/transactions
│   ├── disputes/                    same shape — @cd/disputes
│   ├── lambdas/
│   │   ├── evidence-intake/         src/, test/, Dockerfile (Lambda base image), package.json
│   │   ├── dispute-notifier/
│   │   └── retention-sweeper/
│   └── packages/                    shared libraries (not deployable)
│       ├── shared/                  config, errors, logging, two-port servers
│       ├── auth-client/             /validate client, guards, service-token cache
│       ├── dispute-domain/          PURE rules (eligibility, state machine, isCardExpired)
│       └── db/                      migration runner, bootstrap roles, test helpers
├── frontend/                        React + Vite + TypeScript SPA — @cd/web
│   ├── src/                         routes, screens, api client (generated from OpenAPI), auth (OIDC PKCE)
│   ├── test/
│   ├── nginx.conf
│   └── Dockerfile                   build → nginx-unprivileged
├── infra/
│   └── terraform/                   bootstrap/, modules/*, envs/dev
├── docs/                            specs; docs/openapi/*.yaml is the API contract
├── local/                           mock-issuer/, seed/ (also the dev-tools image source), moto init
├── docker-compose.yml               whole stack locally
├── .github/workflows/               one workflow per deployable + reusable templates
├── pnpm-workspace.yaml              backend/*, backend/lambdas/*, backend/packages/*, frontend
├── orchestration/  .claude/  CLAUDE.md
```

Package names: services `@cd/auth`, `@cd/users`, `@cd/transactions`, `@cd/disputes`; Lambdas `@cd/evidence-intake`, `@cd/dispute-notifier`, `@cd/retention-sweeper`; libs `@cd/shared`, `@cd/auth-client`, `@cd/dispute-domain`, `@cd/db`; web `@cd/web`; local tools `@cd/mock-issuer`, `@cd/seed`.

Rules:
- A service imports only `backend/packages/*`, never another service's folder. Cross-service access goes over HTTP only.
- `frontend/` imports nothing from `backend/`. Its API types are **generated from `docs/openapi`**, so the contract is the only coupling.
- `infra/` is not a pnpm workspace member. It has its own tooling (terraform, tflint, checkov).

---

## 2. Containers

| Artifact | Base image (versions to verify) | Notes |
|---|---|---|
| 4 services | build: `node:24-alpine`; runtime: distroless Node 24 or `node:24-alpine`, ARM64 | multi-stage; `pnpm install --frozen-lockfile --prod --filter @cd/<svc>...` (workspace packages stay symlinks outside node_modules so Node can strip their TS types — `pnpm deploy` breaks this, ADR-052); non-root; read-only root FS; ports 8080 + 8081; `HEALTHCHECK` → `/health` (liveness only; the ALB target group checks `/ready` with lenient thresholds, so a paused DB drains traffic instead of restarting healthy tasks, ADR-066) |
| migrations | same image as the service | entrypoint `migrate`; run as a one-off ECS task before rollout |
| frontend | build: `node:24-alpine`; runtime: `nginxinc/nginx-unprivileged` | static SPA; runtime config through `/config.js` generated at container start (API URL, Cognito ids), so **one image is promoted across envs**; strict CSP; SPA fallback |
| 3 Lambdas | `public.ecr.aws/lambda/nodejs:24` (ARM64) | container-image Lambdas (owner choice); one ECR repo each; handler bundled with esbuild |
| dev-tools | built from `local/seed` (ARM64, non-root) | one image, ECR repo `cd-dev-tools`, three one-shot ECS tasks: `db-bootstrap`, `dev-seed`, `net-probe` (ADR-061). Not a service; run by the dev-tools pipeline |

Nine ECR repos (`cd-<key>`): `svc-auth`, `svc-users`, `svc-transactions`, `svc-disputes`, `web`, `lambda-evidence-intake`, `lambda-dispute-notifier`, `lambda-retention-sweeper`, `dev-tools`.

Standard service env (every service, ADR-053): `PUBLIC_PORT`, `SERVICE_PORT`, `LOG_LEVEL`, `DATABASE_URL` (app role), `DB_POOL_MAX`, `MIGRATOR_DATABASE_URL` (migration task only), `AUTH_URL`, `TOKEN_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`; plus per-service extras documented in each service README.

Service runtime standards (U-01 gate): runtime stage runs `apk upgrade --no-cache`; pg pools set `connectionTimeoutMillis` 5000, `idleTimeoutMillis` 30000, `statement_timeout` 5000 ms (env-overridable).

Upstream calls (T-01 pattern): each service-to-service call gets ONE overall 2 s deadline covering token fetch, request and the http-client GET retry; a per-attempt timeout alone can let a silent upstream take ~4 s.

Image tags: the git SHA (immutable; ECR tag immutability on). No `latest` in any environment.
Scanning: Trivy on every PR build (fail on HIGH/CRITICAL with a fix available) + ECR scan on push. SBOM (SPDX) attached as a build artifact.

### Local (`docker-compose.yml`)
postgres:18, moto (SQS/S3), mock-issuer, auth, users, transactions, disputes, frontend.
- Only frontend (:5173 → nginx) and each service's **8080** are published. All 8081 ports stay on the compose network.
- Lambdas run locally as their containers with the Lambda Runtime Interface Emulator, invoked by test harnesses (M2).

---

## 3. Edge routing — no custom domain (ADR-046)

The owner dropped the custom domain, so AWS default hostnames are used:

| Hostname | What | Purpose |
|---|---|---|
| `https://<id>.cloudfront.net` | CloudFront distribution (default TLS certificate) | web app + API under `/api/*` |
| `https://<prefix>.auth.af-south-1.amazoncognito.com` | Cognito prefix domain | hosted login (PKCE) |

**Routing**
| Path | CloudFront behaviour | Target |
|---|---|---|
| `/api/*` | CloudFront Function strips `/api`; no cache; forwards `Authorization`, `If-Match`, `x-correlation-id` | internal ALB `:80` (origin header `x-cd-route: api`) → users / transactions / disputes **:8080** |
| `/*` | static caching (`/config.js` no-store); SPA fallback in nginx | internal ALB `:80` → web |

There is **one** internal ALB (ADR-059). Its `:80` listener is the CloudFront origin; its `:8081` listener (default 404) lets the evidence-intake and dispute-notifier Lambdas reach the service routes of users and disputes, and its SG admits only those two Lambda SGs.

- **Same origin:** no CORS between app and API. S3 quarantine CORS allows `PUT` only from the distribution hostname (a Terraform output fed into the CORS rule and the frontend config).
- **CloudFront → ALB:**
  - **Chosen (V-M3): a CloudFront VPC origin**, `edge_origin_mode = vpc_origin`. The ALB is internal, in private subnets. Apply order: ALB active, then the VPC origin (up to 15 min), then the ALB SG ingress from `CloudFront-VPCOrigins-Service-SG`. The hop is plain HTTP inside the VPC, acceptable **only with mock data** (ADR-059).
  - **Fallback (not used):** `public_alb`, a public ALB that accepts only the CloudFront origin-facing prefix list plus a secret origin header (about +$7/month).
- **WAF** on CloudFront (scope CLOUDFRONT, us-east-1 provider alias) is **in M3**: CommonRuleSet, KnownBadInputs, an IP rate rule and a body-size COUNT rule on `/api/dispute*`. Tuning is M4.
- **Cognito:** free prefix domain. Callback/logout URL = the distribution hostname (Terraform output).
- **Email:** SES **email identity** `dimakatsomm@icloud.com` as sender, in **sandbox**, so it delivers only to verified recipients (verify the same address as the test inbox). Risk R-6: SES cannot DKIM-sign for icloud.com, so DMARC alignment fails and mail may be spam-foldered (V-05). A domain identity with DKIM is the fix before real users.

## 4. Pipelines (GitHub Actions, OIDC to AWS — no stored keys)

### 4.1 Workflow per deployable
| Workflow | Triggers on changes to | Deploys |
|---|---|---|
| `svc-auth.yml` | `backend/auth/**`, `backend/packages/**`, `docs/openapi/auth.*`, `docs/openapi/common.yaml`, `pnpm-lock.yaml` | ECS service `auth` |
| `svc-users.yml` | same pattern for users | ECS `users` |
| `svc-transactions.yml` | same pattern | ECS `transactions` |
| `svc-disputes.yml` | same pattern | ECS `disputes` |
| `lambda-<name>.yml` ×3 (`lambda-evidence-intake`, `lambda-dispute-notifier`, `lambda-retention-sweeper`) | `backend/lambdas/<name>/**`, `backend/packages/**`, `pnpm-lock.yaml` | Lambda `<name>` (image) |
| `web.yml` | `frontend/**`, `docs/openapi/**`, `pnpm-lock.yaml` | ECS `web` |
| `infra.yml` | `infra/**` | Terraform `dev`; `workflow_dispatch` takes `lambda_image_uris` (CI-02) |
| `dev-tools.yml` (CI-02) | manual dispatch | one-shot ECS tasks `db-bootstrap`, `dev-seed`, `net-probe` on the `dev-tools` image (environment `dev`) |
| `e2e-dev.yml` (CI-02) | manual dispatch | — (API + UI e2e against the deployed `dev`) |
| `oidc-negative.yml` (CI-02) | PR + manual | — (a PR job must get AccessDenied from every role) |
| `contract.yml` | `docs/openapi/**` | — (OpenAPI lint + breaking-change diff vs `main`) |
| `e2e.yml` | nightly + manual | — (full compose stack, API e2e + Playwright UI) |

All service/Lambda/web workflows call **reusable** workflows, so every pipeline behaves the same and is defined once: `_build.yml` today (PR verification), and in CI-02 `_publish.yml` (build, Trivy, SBOM, push `:<git-sha>` on main), `_deploy-ecs.yml` and `_deploy-lambda.yml`. A deploy can be started with `workflow_dispatch` and an existing image `sha`, which is how a config-only Terraform change is rolled out (docs/11).

### 4.2 Stages
```
PR ──► verify ──────────────────────────────────────────────► (merge)
        lint · typecheck · unit · integration (testcontainers)
        contract tests (responses validated against docs/openapi)
        docker build · Trivy scan · SBOM
main ─► build ─► push ECR (tag = SHA) ─► ⏸ approval (GitHub Environment "dev") ─► deploy ─► smoke ─► done
                                                                                    │
                                    services: run migration task → register task-def revision →
                                              ECS update-service → wait stable (deployment
                                              circuit breaker + auto-rollback on failure)
                                    lambdas:  update-function-code → publish version → move alias "live"
                                    web:      same as services (no migrations)
```
- **Manual approval on every deploy** (owner): GitHub Environment `dev` with required reviewers. The deploy job
  pauses until a reviewer approves. ⚠ Verify: required reviewers on **private** repos may need a paid GitHub plan.
- `infra.yml`: on PR → `fmt -check`, `validate`, `terraform test`, `tflint`, `checkov`. **PRs have no AWS access and post no plan** (ADR-060): a PR job can never present the `main` or `environment:dev` OIDC sub.
  On main → `plan` with the read-only `gha-infra-plan` role → the plan is written to the encrypted state bucket as `plans/<git-sha>` (never a GitHub artifact; output masked) → ⏸ approval (environment `dev-infra`, separate from app deploys) → `gha-infra-apply` applies exactly the approved S3 version after a sha256 check. The plan job declares no environment, so it reads repository variables, while the apply job reads Environment variables (docs/11 step 2).
- Concurrency: one deploy per workflow at a time (`concurrency: deploy-<name>`); newer runs queue.
- Shared-package changes rebuild every dependent. Each deploy is still approved per service.

### 4.3 Terraform ↔ pipelines ownership
- Terraform owns infrastructure: cluster, services (created at `desired_count` 0), ALB, IAM, ECR repos, Lambdas. Lambda **roles and log groups** exist from the first apply; the **functions** are created only when their key is in `lambda_image_uris`, after the image is published (ADR-066).
- Pipelines own **image versions** and the running count: Terraform sets `lifecycle { ignore_changes = [task_definition, desired_count] }` on ECS
  services and `ignore_changes = [image_uri]` on Lambdas, so apply never rolls back a deployed version. Consequence: a **config-only Terraform change** (environment variables, secrets, SG) updates the task definition Terraform manages but does not reach running tasks until the service is redeployed (dispatch the deploy workflow with the current sha, docs/11).
- Each pipeline has its own OIDC role, scoped to **its** ECR repo and **its** ECS service / Lambda (least privilege).

### 4.4 Database migrations
- Run by the service pipeline before the rollout, as a one-off ECS task using the new image, connecting as `<svc>_migrator`.
- Expand → contract only: a migration must work with both the old and new code (rolling deploys + rollback).
- A failed migration stops the deploy. The old tasks keep running.

---

## 5. Cost delta (dev)
- Frontend task (0.25 vCPU / 0.5 GB ARM): ≈ $9.7/month (same unit cost as the services).
- ECR storage for the 9 repos (incl. `dev-tools`) with lifecycle "keep last 10": ~$1–2/month.
- GitHub Actions minutes: depends on the plan. ⚠ To verify.

---

## 6. Public repository & approvals (ADR-041, owner 2026-10-19)

GitHub plan: **Free**. Environment *required reviewers* exist on private repos only with Enterprise Cloud
(verified, orchestration/verify-claims-02.md #4), so the repository is **public**. That keeps the
"⏸ manual approval on every deploy" gate (§4.2) through the GitHub Environment `dev` with required reviewers.

Public-repo hardening (all mandatory, CI-01/CI-02 acceptance):
- **No secrets in git, ever**: GitHub secret scanning + **push protection** on; a pre-commit/CI secret scan (e.g. gitleaks — version to verify) runs on every PR.
- **Fork PRs**: workflows use `pull_request` (never `pull_request_target` with a checkout of PR code). Fork runs get no secrets and no OIDC.
  "Require approval for all outside collaborators" is set for Actions.
- **OIDC trust**: every AWS role's trust policy pins `token.actions.githubusercontent.com:sub` to
  `repo:<owner>/<repo>:environment:dev` (deploy, infra apply, tools, e2e) or `repo:<owner>/<repo>:ref:refs/heads/main` (build/push, infra plan), with audience `sts.amazonaws.com`. Never `repo:<owner>/<repo>:*`. A PR job without an environment presents `repo:<owner>/<repo>:pull_request` and is refused everywhere.
- **Workflow permissions**: default `contents: read`; `id-token: write` only on jobs that assume AWS roles; all third-party actions pinned to a full commit SHA.
- **Branch protection on `main`** (free on public repos): PR required, `ci-gate` status check required, **0 required approvals**, admin bypass, no force-push (ADR-063).
- **Environment `dev`**: required reviewer = `@dimakatsomm`; **prevent self-review OFF** (the owner is the only approver of their own deploys); deployment branches = `main` only and never `refs/pull/*/merge` (V-M3 10c: otherwise a PR job could present the `environment:dev` sub).
- **CODEOWNERS**: `@dimakatsomm` owns `.github/`, gitleaks config, `tools/`, lint/workspace config and `docs/openapi/`. Review is informational while required approvals are 0.
- **Data**: seed data is fake (`example.com`, synthetic names). The owner email appears in the docs by owner choice.

## 7. Build notes from verification (verify-claims-02)
- Lambda images: `FROM public.ecr.aws/lambda/nodejs:24` (AL2023, arm64 published). Build with `docker buildx build --platform linux/arm64 --provenance=false` (AWS requirement for Lambda images).
- CI runners: `ubuntu-24.04-arm` standard runners for ARM64 image builds (native, no QEMU). On a public repo, standard runners are free.
- TypeScript is pinned to **6.0.x**, because typescript-eslint 8.72 supports TS < 6.1. Revisit when typescript-eslint supports TS 7.
