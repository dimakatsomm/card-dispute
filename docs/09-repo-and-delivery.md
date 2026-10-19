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
│   └── terraform/                   bootstrap/, modules/*, envs/poc
├── docs/                            specs; docs/openapi/*.yaml is the API contract
├── local/                           mock-issuer/, seed/, moto init
├── docker-compose.yml               whole stack locally
├── .github/workflows/               one workflow per deployable + reusable templates
├── pnpm-workspace.yaml              backend/*, backend/lambdas/*, backend/packages/*, frontend
├── orchestration/  .claude/  CLAUDE.md
```

Rules:
- A service imports only `backend/packages/*`, never another service's folder. Cross-service access goes over HTTP only.
- `frontend/` imports nothing from `backend/`. Its API types are **generated from `docs/openapi`**, so the contract is the only coupling.
- `infra/` is not a pnpm workspace member. It has its own tooling (terraform, tflint, checkov).

---

## 2. Containers

| Artifact | Base image (versions to verify) | Notes |
|---|---|---|
| 4 services | build: `node:24-alpine`; runtime: distroless Node 24 or `node:24-alpine`, ARM64 | multi-stage; `pnpm deploy --filter @cd/<svc> --prod` for a pruned `node_modules`; non-root; read-only root FS; ports 8080 + 8081; `HEALTHCHECK` → `/health` |
| migrations | same image as the service | entrypoint `migrate`; run as a one-off ECS task before rollout |
| frontend | build: `node:24-alpine`; runtime: `nginxinc/nginx-unprivileged` | static SPA; runtime config through `/config.js` generated at container start (API URL, Cognito ids), so **one image is promoted across envs**; strict CSP; SPA fallback |
| 3 Lambdas | `public.ecr.aws/lambda/nodejs:24` (ARM64) | container-image Lambdas (owner choice); one ECR repo each; handler bundled with esbuild |

Image tags: the git SHA (immutable; ECR tag immutability on). No `latest` in any environment.
Scanning: Trivy on every PR build (fail on HIGH/CRITICAL with a fix available) + ECR scan on push. SBOM (SPDX) attached as a build artifact.

### Local (`docker-compose.yml`)
postgres:18, moto (SQS/S3), mock-issuer, auth, users, transactions, disputes, frontend.
- Only frontend (:5173 → nginx) and each service's **8080** are published. All 8081 ports stay on the compose network.
- Lambdas run locally as their containers with the Lambda Runtime Interface Emulator, invoked by test harnesses (M2).

---

## 3. Domain & edge routing (ADR-037)

**Domain:** `<app-domain>`, a subdomain of the owner's existing `<owner-domain>` (Route 53).
- **Delegated sub-zone:** Terraform creates a hosted zone for `<app-domain>` and adds **one NS record** in the parent zone.
  It never creates, changes or deletes any other record of the existing site. ⚠ Confirm the parent hosted zone is in the same AWS account (Q-18); otherwise the 4 NS records are added by hand once.

| Name | Points to | Purpose |
|---|---|---|
| `<app-domain>` | CloudFront (alias A/AAAA) | web app + API (`/api/*`) |
| `<alb-origin>` | ALB (alias) | CloudFront → ALB over **HTTPS** (ACM cert in af-south-1) |
| `<cognito-domain>` | Cognito custom domain (optional, see below) | hosted login |
| DKIM ×3 CNAME, `<mail-from>` MX + SPF TXT, `<dmarc>` TXT | SES | signed email from `noreply@<app-domain>` |

Certificates (ACM, DNS-validated in the sub-zone, auto-renewing):
- us-east-1: `<app-domain>` (+ `<cognito-domain>`) for CloudFront / Cognito.
- af-south-1: `<alb-origin>` for the ALB.

**Routing** (unchanged shape, now on the real hostname):
| Path | CloudFront behaviour | Target |
|---|---|---|
| `/api/*` | CloudFront Function strips `/api`; no cache; forwards `Authorization`, `If-Match`, `x-correlation-id` | ALB → users / transactions / disputes **:8080** |
| `/*` | static caching; SPA fallback in nginx | ALB → web |

- **Same origin:** no CORS between app and API. S3 quarantine CORS allows `PUT` only from `https://<app-domain>`.
- **ALB exposure:** CloudFront → ALB is HTTPS end-to-end. The ALB accepts only CloudFront (origin-facing
  managed prefix list + secret origin header). If CloudFront VPC origins are available in af-south-1 (V-06), the ALB
  becomes internal instead — an improvement, no longer a requirement.
- **WAF** on CloudFront (scope CLOUDFRONT, us-east-1 provider alias).
- **Cognito:** custom domain `<cognito-domain>` gives a branded login (needs the us-east-1 cert + an A alias record). The
  free prefix domain remains the fallback if setup is fiddly. Callback/logout URL: `https://<app-domain>/`.
- **Email:** SES domain identity `<app-domain>` with Easy DKIM, custom MAIL FROM `<mail-from>`, DMARC `p=quarantine`.
  Sender `noreply@<app-domain>`; replies go to `dimakatsomm@icloud.com` (Reply-To). SES stays in **sandbox** for the POC:
  delivery only to verified recipients (verify `dimakatsomm@icloud.com` and any test inbox).

## 4. Pipelines (GitHub Actions, OIDC to AWS — no stored keys)

### 4.1 Workflow per deployable
| Workflow | Triggers on changes to | Deploys |
|---|---|---|
| `svc-auth.yml` | `backend/auth/**`, `backend/packages/**`, `docs/openapi/auth.*`, `docs/openapi/common.yaml`, `pnpm-lock.yaml` | ECS service `auth` |
| `svc-users.yml` | same pattern for users | ECS `users` |
| `svc-transactions.yml` | same pattern | ECS `transactions` |
| `svc-disputes.yml` | same pattern | ECS `disputes` |
| `lambda-<name>.yml` ×3 | `backend/lambdas/<name>/**`, `backend/packages/**`, `pnpm-lock.yaml` | Lambda `<name>` (image) |
| `web.yml` | `frontend/**`, `docs/openapi/**`, `pnpm-lock.yaml` | ECS `web` |
| `infra.yml` | `infra/**` | Terraform `poc` |
| `contract.yml` | `docs/openapi/**` | — (OpenAPI lint + breaking-change diff vs `main`) |
| `e2e.yml` | nightly + manual | — (full compose stack, API e2e + Playwright UI) |

All service/Lambda/web workflows call two **reusable** workflows (`_build.yml`, `_deploy.yml`), so every
pipeline behaves the same and is defined once.

### 4.2 Stages
```
PR ──► verify ──────────────────────────────────────────────► (merge)
        lint · typecheck · unit · integration (testcontainers)
        contract tests (responses validated against docs/openapi)
        docker build · Trivy scan · SBOM
main ─► build ─► push ECR (tag = SHA) ─► ⏸ approval (GitHub Environment "poc") ─► deploy ─► smoke ─► done
                                                                                    │
                                    services: run migration task → register task-def revision →
                                              ECS update-service → wait stable (deployment
                                              circuit breaker + auto-rollback on failure)
                                    lambdas:  update-function-code → publish version → move alias "live"
                                    web:      same as services (no migrations)
```
- **Manual approval on every deploy** (owner): GitHub Environment `poc` with required reviewers. The deploy job
  pauses until a reviewer approves. ⚠ Verify: required reviewers on **private** repos may need a paid GitHub plan.
- `infra.yml`: on PR → `fmt -check`, `validate`, `tflint`, `checkov`, `plan` posted as a PR comment.
  On main → `plan -out` → ⏸ approval → `apply` of that saved plan.
- Concurrency: one deploy per workflow at a time (`concurrency: deploy-<name>`); newer runs queue.
- Shared-package changes rebuild every dependent. Each deploy is still approved per service.

### 4.3 Terraform ↔ pipelines ownership
- Terraform owns infrastructure: cluster, services, ALB, IAM, ECR repos, Lambda functions with an initial image.
- Pipelines own **image versions**: Terraform sets `lifecycle { ignore_changes = [task_definition] }` on ECS
  services and `ignore_changes = [image_uri]` on Lambdas, so apply never rolls back a deployed version.
- Each pipeline has its own OIDC role, scoped to **its** ECR repo and **its** ECS service / Lambda (least privilege).

### 4.4 Database migrations
- Run by the service pipeline before the rollout, as a one-off ECS task using the new image, connecting as `<svc>_migrator`.
- Expand → contract only: a migration must work with both the old and new code (rolling deploys + rollback).
- A failed migration stops the deploy. The old tasks keep running.

---

## 5. Cost delta (POC)
- Frontend task (0.25 vCPU / 0.5 GB ARM): ≈ $9.7/month (same unit cost as the services).
- ECR storage for ~9 repos with lifecycle "keep last 10": ~$1–2/month.
- GitHub Actions minutes: depends on the plan. ⚠ To verify.

---

## 6. Public repository & approvals (ADR-041, owner 2026-10-19)

GitHub plan: **Free**. Environment *required reviewers* exist on private repos only with Enterprise Cloud
(verified, orchestration/verify-claims-02.md #4), so the repository is **public**. That keeps the
"⏸ manual approval on every deploy" gate (§4.2) through the GitHub Environment `poc` with required reviewers.

Public-repo hardening (all mandatory, CI-01/CI-02 acceptance):
- **No secrets in git, ever**: GitHub secret scanning + **push protection** on; a pre-commit/CI secret scan (e.g. gitleaks — version to verify) runs on every PR.
- **Fork PRs**: workflows use `pull_request` (never `pull_request_target` with a checkout of PR code). Fork runs get no secrets and no OIDC.
  "Require approval for all outside collaborators" is set for Actions.
- **OIDC trust**: every AWS deploy role's trust policy pins `token.actions.githubusercontent.com:sub` to
  `repo:<owner>/<repo>:environment:poc` (deploy) or `repo:<owner>/<repo>:ref:refs/heads/main` (build/push). Never `repo:<owner>/<repo>:*`.
- **Workflow permissions**: default `contents: read`; `id-token: write` only on jobs that assume AWS roles; all third-party actions pinned to a full commit SHA.
- **Branch protection on `main`** (free on public repos): PR required, status checks required, no force-push.
- **Environment `poc`**: required reviewers = owner; deployment branches = `main` only.
- **Data**: seed data is fake (`example.com`, synthetic names). The owner email and the poc domain appear in the docs by owner choice.

## 7. Build notes from verification (verify-claims-02)
- Lambda images: `FROM public.ecr.aws/lambda/nodejs:24` (AL2023, arm64 published). Build with `docker buildx build --platform linux/arm64 --provenance=false` (AWS requirement for Lambda images).
- CI runners: `ubuntu-24.04-arm` standard runners for ARM64 image builds (native, no QEMU). On a public repo, standard runners are free.
- TypeScript is pinned to **6.0.x**, because typescript-eslint 8.72 supports TS < 6.1. Revisit when typescript-eslint supports TS 7.
