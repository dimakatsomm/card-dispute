# evidence-intake

Container-image Lambda triggered by the EventBridge event `GuardDuty Malware Protection Object Scan Result` for the quarantine bucket. It reports the result to disputes `PUT /dispute/{transactionId}/evidence/{evidenceId}` (service port, scope `disputes/evidence.write`). On `STORED` it copies the object to the evidence bucket at the `s3Key` that disputes returns, then deletes the quarantine copy. On `REJECTED`, or a 409 `EVIDENCE_CLOSED`, it only deletes. Every other failure throws, so the async invoke retries twice and then sends the event to the DLQ. That includes a 409 `RESULT_CONFLICT` (which also emits the `EvidenceResultConflict` metric) and any unknown 409.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `AWS_REGION` | yes | Region for the S3 and Secrets Manager clients |
| `AWS_ENDPOINT_URL` | no | Local endpoint (moto); also switches S3 to path-style addressing |
| `QUARANTINE_BUCKET` | yes | The only bucket accepted in events |
| `EVIDENCE_BUCKET` | yes | Where `STORED` objects are copied |
| `DISPUTES_SERVICE_URL` | yes | disputes service port (internal ALB in AWS) |
| `TOKEN_URL` | yes | Cognito (or mock-issuer) token endpoint |
| `SERVICE_CLIENT_ID` | yes | `svc-evidence-intake` |
| `SERVICE_CLIENT_SECRET` | one of | Client secret from env (local only) |
| `SERVICE_CLIENT_SECRET_ID` | one of | Secrets Manager id/ARN of the client secret (AWS) |
| `EVIDENCE_REQUIRE_SCAN` | no, default `true` | `false` is the V-03 fallback: also accept S3 `Object Created` events, which are processed without a verdict and emit `EvidenceNotScanned` |
| `LOG_LEVEL` | no, default `info` | pino level |

Set exactly one of `SERVICE_CLIENT_SECRET` and `SERVICE_CLIENT_SECRET_ID`. The Secrets Manager `SecretString` must hold the client secret as a **raw string, not JSON**. Surrounding whitespace is trimmed.

## Build

`pnpm --filter @cd/evidence-intake bundle` writes `dist/index.mjs`. The `Dockerfile` (build context = repo root) bundles the code and copies the result onto `public.ecr.aws/lambda/nodejs:24` with `CMD ["index.handler"]`.
