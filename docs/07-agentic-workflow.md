# 07 — Agentic Workflow

Claude orchestrates; specialist agents implement. Process follows the `agentic-build` skill.

## Loop
1. `/next` — pick the unblocked tasks whose `owns` sets don't overlap; dispatch one agent per task with a self-contained brief.
2. `/gate <task>` — test-engineer (criteria covered by executing tests), code-standards-reviewer, and
   security-reviewer where required (auth, auth-client, disputes, IAM, input handling). Findings go back to the original implementer.
3. Two failed gate rounds → task is re-scoped, not patched.
4. `/milestone-close` — integration-verifier checks the milestone's stated outcome; report written to `orchestration/reports/`.
5. `/verify-claims` and `/peer-review` before each milestone's code starts when its docs change.

## Agents
| Agent | Owns (default) | Use for |
|---|---|---|
| `service-api` | `backend/*/src/**`, `backend/*/test/**` (one service per task) | Fastify routes, handlers, repositories |
| `dispute-domain` | `backend/packages/dispute-domain/**` | state machine, eligibility rules |
| `data-schema` | `backend/*/migrations/**`, `local/seed/**` | SQL migrations, roles, grants, seed |
| `async-lambda` | `backend/lambdas/*/**` | SQS consumers, scheduled jobs |
| `infra-terraform` | `infra/terraform/**` | Terraform modules + env |
| `implementer` (generic) | `backend/packages/shared`, `backend/packages/auth-client`, `backend/packages/db`, `local/` tooling, CI | shared libs and glue |
| gate agents | read-only | test-engineer, code-standards-reviewer, security-reviewer, integration-verifier |

## Rules
- Docs are the contract. A spec error is reported; the orchestrator fixes the doc, then re-dispatches.
- An agent needing a file outside `owns` stops and reports.
- No agent commits; the orchestrator commits after the gate passes.
- Owner decides scope, money and product calls (`state.json` → `openQuestions`).
- Done = observed passing output, never prediction.
