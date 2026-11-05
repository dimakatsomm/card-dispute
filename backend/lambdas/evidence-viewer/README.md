# evidence-viewer

Container-image Lambda invoked synchronously by disputes (`lambda:InvokeFunction`, ADR-072) when a back-office agent
downloads an evidence file. It parses the payload with `evidenceViewRequestSchema` from `@cd/dispute-domain`
(`{disputeId, evidenceId, contentType, correlationId}`; strict, so a key, bucket or file name in the payload is rejected),
builds the key with `evidenceObjectKey` and returns `{url, expiresAt}` (`evidenceViewResponseSchema`): a presigned
`GetObject` valid for `EVIDENCE_VIEW_URL_TTL_SECONDS`, served as `attachment; filename="<evidenceDownloadFileName>"`
with the declared content type and `Cache-Control: no-store`.

Signing is local. The viewer makes no S3, DB or service calls, so a URL for a missing object only fails when fetched.
An invalid payload, or a minted URL that is not https, throws, so disputes sees a function error and answers 503.
Each success logs one line, `evidence url minted`, with `disputeId`, `evidenceId` and `correlationId`; the URL is never logged.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `AWS_REGION` | yes | Region of the evidence bucket |
| `EVIDENCE_BUCKET` | yes | Bucket holding `evidence/{disputeId}/{evidenceId}` |
| `AWS_ENDPOINT_URL` | no | Local S3 endpoint (moto). It also switches to path-style addressing and is the only setting that permits a plain-http URL. Other SDK endpoint settings, such as `AWS_ENDPOINT_URL_S3`, are ignored |
| `LOG_LEVEL` | no, default `info` | pino level |

## Build

`pnpm --filter @cd/evidence-viewer bundle` writes `dist/index.mjs`. The `Dockerfile` (build context = repo root) bundles the
code and copies it onto `public.ecr.aws/lambda/nodejs:24` with `CMD ["index.handler"]`.
