# M2-00 verification (2026-10-20)

Environment: moto 5.2.4 from the compose stack (http://localhost:55000), AWS SDK v3 3.1152.0 clients, Node 26.3.1 on the host.
Scripts were throwaway and kept outside the repo. All resources created were deleted (buckets `cd-evidence-quarantine` and `cd-evidence` untouched).

## moto

| Check | Result |
|---|---|
| SQS RedrivePolicy (maxReceiveCount 3, visibility 1 s) | Works. Receives 1, 2, 3 show ApproximateReceiveCount 1, 2, 3. The 4th receive returns nothing and the message is in the DLQ with its original body. Main queue ends 0 visible / 0 in flight. |
| PutObjectTagging / GetObjectTagging | Works. Set, read, overwrite (`GuardDutyMalwareScanStatus` NO_THREATS_FOUND then THREATS_FOUND). HeadObject reports TagCount. |
| Self-copy `CopyObject` with ChecksumAlgorithm SHA256 | Works, keeps tags and content type, and adds a checksum (see next row). |
| Presigned PUT, signer settings from upload-signer.ts (unhoisted checksum, signed content-type and content-length) | URL signs `content-length;content-type;host;x-amz-checksum-sha256`. PUT with the exact headers returns 200. |
| Presigned PUT enforcement | **moto enforces nothing.** A tampered body, a wrong `x-amz-checksum-sha256` value, an omitted checksum header and a wrong Content-Type all return 200 and store the object. A body longer than the signed Content-Length hangs the request (client timeout). V-08 stays open for E-03 (real S3). |
| Checksum is stored | **No.** After a presigned PUT, `HeadObject` with ChecksumMode ENABLED returns no ChecksumSHA256. An SDK `PutObject` with `ChecksumSHA256` also stores none and also accepts a wrong value. Only `CopyObject` with ChecksumAlgorithm SHA256 produces one (computed from the actual bytes). |
| Ranged GET (`Range: bytes=0-4`) | Works, returns `%PDF-`. |
| CopyObject to another bucket, DeleteObject, HeadObject after delete | Work. Head on a deleted key gives NotFound / 404. A second DeleteObject returns 204. |
| Bucket-policy Deny on `s3:GetObject` with `s3:ExistingObjectTag/...` condition | Enforced crudely: GetObject is denied (403, error name Unknown) both for an untagged object and for an object tagged NO_THREATS_FOUND. The tag condition is not evaluated. So a production-style policy cannot be reproduced on moto; do not put it on the local bucket. |

Consequences for later tasks:
- L-03 treats a missing `ChecksumSHA256` as CHECKSUM. On moto every upload has none, so the local flow would reject every file. L-06's scan stub should do the self-copy with `ChecksumAlgorithm: 'SHA256'` (it keeps tags) before posting the event, and document that the local checksum is computed from the stored bytes and so cannot detect tampering. The tamper and checksum-mismatch proof stays with E-03.
- Presigned-PUT tamper/type/length rejection is not testable locally (V-08, E-03).
- L-03/L-07 tests must not apply the production bucket policy on moto.

## Lambda RIE (public.ecr.aws/lambda/nodejs:24, digest sha256:66c547b0...)

Pulled; image arch on this host is amd64 (CI builds arm64). Handler mounted read-only at /var/task, container port 8080 published on 127.0.0.1 only, `AWS_LAMBDA_FUNCTION_TIMEOUT=2`. Invoke URL `/2015-03-31/functions/function/invocations`. Runtime reports Node v24.21.0.

| Case | Behaviour |
|---|---|
| Success | 200, body = handler return value as JSON. |
| Handler throws | **200** (not an error status), body `{"errorType","errorMessage","trace":[...]}`. No `X-Amz-Function-Error` header. A driver must detect failure from the body (`errorType`/`errorMessage`), not the status. |
| SQS-style event | 200, `{"batchItemFailures":[{"itemIdentifier":"m2"}]}` passed through unchanged. |
| `X-Amz-Invocation-Type: Event` | **Not async.** RIE ignores it: 200 with the handler result, after the handler finishes. The async 202 and the 2 retries must be emulated by the driver (L-06 already plans this). |
| Timeout | 200, text/plain body `Task timed out after 2.00 seconds`, returned at about 1.95 s. Not JSON; the driver must treat a non-JSON 200 body as failure. |
| Body that is not valid JSON | 502, `{"errorType":"Runtime.ExitError",...}`; the runtime process restarts and the next invoke works. |
| After a timeout or crash | The next invocation succeeds (fresh init). |
| Content-Type | `text/plain; charset=utf-8` for JSON results as well. |

## Workflows with a package that has no source

`_build.yml` finds `package.json`, so the three `lambda-*.yml` pipelines now run: install `--frozen-lockfile` (passes locally), lint and typecheck are skipped (`--if-present`, no scripts), test runs `vitest run --passWithNoTests` (exit 0, verified with `pnpm --filter @cd/evidence-intake test`). `has_docker` is false (no Dockerfile), so no image build, Trivy or SBOM step runs. Sensible; no workflow change needed. Without `--passWithNoTests` vitest would exit 1, so each Lambda task should keep the flag until it has tests (or drop it once tests exist). `@cd/lambda-driver` has no workflow.

## Commands (PATH with node v26.3.1)

- `pnpm lint:api`: "Your API descriptions are valid", no warnings (after all spec edits).
- `pnpm gen:contracts`: 7 specs generated; diff only in `disputes.service/zod.ts` (lookup `version: z.int().gte(1)`; PUT response `s3Key` optional) and `disputes.public/zod.ts` (new `zResponseDescription` union; `zDispute`, `zDisputeCreated`, `zDisputeDetail` use it).
- `pnpm --filter @cd/web gen:api` then `check:api`: clean; only `frontend/src/api/generated/disputes.ts` changed (13 lines).
- `pnpm lint`: exit 0.
- `pnpm -r typecheck`: **fails in backend/disputes only**: `src/routes/service.ts(28,38): TS2322 Type 'DisputeRef[]' is not assignable ... Property 'version' is missing in type 'DisputeRef'`. All other packages pass. Expected consequence of the lookup `version`; services were out of scope.
- `pnpm test` (`pnpm -r --if-present --no-bail --filter "!@cd/e2e" test`): shared 42, mock-issuer 20, lint-rules 15, frontend 97, dispute-domain 136, db 33, contracts 35, seed 14, auth-client 68, auth 65, users 56 pass. Failures, all from the lookup `version` becoming required:
  - disputes `test/service.test.ts` "GET :8081/disputes ... returns only that user's disputes ... in the shape transactions parses": response fails the generated schema (`items.N.version` undefined).
  - transactions `test/routes/public.test.ts`, two tests ("computes dispute + disputable per row ...", "recovers from a stale service token ..."): the test double for disputes returns items without `version`, so the transactions client rejects the response and degrades `disputable.allowed` to false.
  A first frontend run showed one failing polling test (`DisputeDetailPolling.test.tsx`, "still checking" text) in files another agent was editing at the time (W-06); the re-run passed 97/97.
