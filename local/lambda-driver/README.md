# lambda-driver

Local stand-ins for the AWS pieces that trigger and serve the three Lambdas. Not deployed, and not referenced by any Dockerfile.

**This is emulation, not AWS.** It copies the shape of GuardDuty, EventBridge, the Lambda event-source mapping and SES closely enough to run the flows locally. It proves nothing about the real services: S3 enforcement of the presigned PUT (type, length, sha256), GuardDuty verdicts, bucket policies, IAM and real Lambda retry timing are proven only against real AWS (E-03).

## Modes

`node src/main.ts <mode>` (or `pnpm --filter @cd/lambda-driver start <mode>`). Run each mode as its own process.

| Mode | What it does |
|---|---|
| `scan-stub` | Lists the quarantine bucket. For each object without a `GuardDutyMalwareScanStatus` tag: self-copies it with `ChecksumAlgorithm: SHA256`, tags it `THREATS_FOUND` (contains the EICAR test string) or `NO_THREATS_FOUND`, then POSTs a `GuardDuty Malware Protection Object Scan Result` event to the evidence-intake RIE. A failed intake invoke is retried twice (async-invoke emulation), then the original event is sent to `evidence-intake-dlq`. |
| `sqs-poller` | Long-polls the notifications queue (batches of up to 10), invokes the dispute-notifier RIE with an SQS event, deletes only records not in `batchItemFailures`, and deletes nothing when the function errors. Repeats go to the DLQ through moto's RedrivePolicy. |
| `ses-sink` | HTTP server for SESv2 `POST /v2/email/outbound-emails`. `GET /sent` lists stored messages, `DELETE /sent` clears them. With `SES_VERIFIED` set, mail to any other recipient gets a `MessageRejected` 400. |
| `invoke <function> [json]` | Invokes `evidence-intake`, `dispute-notifier` or `retention-sweeper` once (default payload `{}`). Stands in for the EventBridge schedule of the sweeper. Exit 1 on function error. |

The RIE answers 200 even when the handler throws or times out, so failure is read from the body: a JSON body with `errorType`, or a non-JSON body (the timeout text).

## Local checksums cannot detect tampering

moto stores no SHA-256 checksum on PUT and accepts a wrong one. The scan stub self-copies each object so `HeadObject` returns a checksum, but that checksum is computed from the stored bytes, so it always matches what is stored. The upload-tamper and checksum-mismatch proof stays with real S3.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AWS_ENDPOINT_URL` | required | moto, for example `http://moto:5000` |
| `AWS_REGION` or `AWS_DEFAULT_REGION` | required | |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | required | local dummies, from env only |
| `QUARANTINE_BUCKET` | `cd-evidence-quarantine` | |
| `INTAKE_URL`, `NOTIFIER_URL`, `SWEEPER_URL` | required | RIE invoke URLs (`/2015-03-31/functions/function/invocations`) |
| `INTAKE_DLQ_NAME` | `evidence-intake-dlq` | must exist (moto-init, L-07) |
| `INTAKE_RETRY_DELAY_MS` | `1000` | pause between intake retries |
| `SCAN_INTERVAL_MS` | `2000` | bucket listing interval |
| `NOTIFICATIONS_QUEUE_NAME` | `dispute-notifications` | |
| `INVOKE_TIMEOUT_MS` | `60000` | client timeout per invoke |
| `SES_PORT` | `55901` | |
| `SES_VERIFIED` | unset | comma list of accepted recipients; unset accepts all |

## Tests

`pnpm --filter @cd/lambda-driver test` needs moto from the compose stack (`MOTO_ENDPOINT`, default `http://localhost:55000`). The RIE is faked in-process; each test creates and deletes its own buckets and queues.
