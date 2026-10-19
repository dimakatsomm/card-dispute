# Verify claims 02 — V-03, V-04, V-07

Date checked: 2026-10-19 (all items). Primary sources only. npm versions come from `registry.npmjs.org/<pkg>/latest`. The AWS af-south-1 price list was read from the public AWS Price List API.

---

## V-03 — Evidence upload (needed before dispute-create)

### 1. Presigned PUT with signed `x-amz-checksum-sha256`, Content-Type, Content-Length
**Verdict: CONFIRMED, with caveats.**

- S3 PutObject accepts `x-amz-checksum-sha256` (= `ChecksumSHA256`). Its value is "the Base64 encoded, 256-bit SHA256 digest of the object", meaning base64 of the raw 32 bytes, not hex. If the value does not match the body, S3 rejects the request with `BadDigest`.
  - https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
  - https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- The official s3-request-presigner README gives the exact pattern: `new PutObjectCommand({ Bucket, Key, ChecksumSHA256: sha })` plus `getSignedUrl(client, cmd, { expiresIn, unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) })`. The README says this forces the header to be present in the upload request.
  - https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md
- Caveats, verified in SDK source:
  - **Hoisting.** By default the presigner moves every `x-amz-*` header into the query string (`moveHeadersToQuery`). Without `unhoistableHeaders` the checksum ends up as a query parameter, not a signed header the client must send. Always pass `unhoistableHeaders`.
    - https://github.com/smithy-lang/smithy-typescript/blob/main/packages/signature-v4/src/moveHeadersToQuery.ts
  - **The client must send the header.** The browser PUT must carry `x-amz-checksum-sha256: <base64>` with exactly the signed value. Otherwise S3 returns `SignatureDoesNotMatch`.
  - **Content-Type is unsigned by default.** `S3RequestPresigner.prepareRequest` does `unsignableHeaders.add("content-type")`. To enforce it, pass `signableHeaders: new Set(["content-type"])`, which overrides the unsignable set in `getCanonicalHeaders`. The README documents this option.
    - https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/src/presigner.ts
    - https://github.com/smithy-lang/smithy-typescript/blob/main/packages/signature-v4/src/getCanonicalHeaders.ts
  - **Content-Length can be signed.** It is not in smithy `ALWAYS_UNSIGNABLE_HEADERS` (that list is authorization, cache-control, connection, expect, from, keep-alive, max-forwards, pragma, referer, te, trailer, transfer-encoding, upgrade, user-agent, x-amzn-trace-id). If `ContentLength` is set on the command, it is signed and the request must match exactly. That gives exact-length enforcement, not a range. In practice the signed SHA-256 already pins the exact bytes, and therefore the length.
    - https://github.com/smithy-lang/smithy-typescript/blob/main/packages/signature-v4/src/constants.ts
  - **A range limit (`content-length-range`) exists only in a presigned POST policy**, not in a presigned PUT.
    - https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html
  - **Default checksum behaviour.** The SDK default integrity change (aws-sdk-js-v3 #6810, since v3.729.0) can sign a CRC32 of an empty body into presigned PUTs. Supplying `ChecksumSHA256` explicitly avoids this. Add a unit test asserting that the URL/signed headers contain only the SHA-256 checksum and no `x-amz-checksum-crc32`.
    - https://github.com/aws/aws-sdk-js-v3/issues/6810
  - **CORS.** The quarantine bucket CORS must allow `PUT` and headers `content-type` and `x-amz-checksum-sha256`.
  - **UNVERIFIED:** whether moto server enforces `BadDigest` or the signed checksum on presigned PUTs. A local test may pass without proving that S3 rejects bad uploads, so the rejection needs one test against real S3 in poc.
- **Impact:** ADR-028 is workable with a presigned PUT. The signing code must use `ChecksumSHA256`, `ContentType`, `ContentLength`, `unhoistableHeaders:["x-amz-checksum-sha256"]` and `signableHeaders:["content-type","content-length"]`. The frontend must send these headers exactly.

### 2. GuardDuty Malware Protection for S3 in af-south-1
**Verdict: CONFIRMED (available).**

- **Availability.**
  - GuardDuty has an af-south-1 endpoint: https://docs.aws.amazon.com/general/latest/gr/guardduty.html
  - The region-specific feature page lists no exclusion for Malware Protection for S3: https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_regions.html
  - The AWS Price List for af-south-1 (version 20261008231203) contains `AFS1-MalwareProtectionS3DataScanned` and `AFS1-MalwareProtectionS3ScanRequest` SKUs.
  - The feature can be enabled independently, without a GuardDuty detector. In that mode no findings are created and only events and tags are produced: https://docs.aws.amazon.com/guardduty/latest/ug/gdu-malware-protection-s3.html
- **Pricing, af-south-1** (Price List API: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonGuardDuty/current/af-south-1/index.json):
  - Data scanned: first 1 GB/month free, then **$0.099/GB**.
  - Objects: first 1,000 PUT requests/month free, then **$0.000237 per object** (= $0.237 per 1,000).
  - For comparison, us-east-1 on https://aws.amazon.com/guardduty/pricing/ is $0.09/GB and $0.215 per 1,000 objects.
  - S3 API and tagging costs are billed separately.
- **Results reporting:**
  - **EventBridge, default bus.** `source: "aws.guardduty"`, `detail-type: "GuardDuty Malware Protection Object Scan Result"`.
    - Detail fields: `scanStatus` (COMPLETED | SKIPPED | FAILED), `resourceType: "S3_OBJECT"`, `s3ObjectDetails{bucketName, objectKey, eTag, versionId, s3Throttled}`, `scanResultDetails{scanResultStatus, threats, statusReasons}`.
    - Other detail-types: `GuardDuty Malware Protection Post Scan Action Failed` (tagging failed) and `GuardDuty Malware Protection Resource Status Active|Warning|Error`.
    - https://docs.aws.amazon.com/guardduty/latest/ug/monitor-with-eventbridge-s3-malware-protection.html
  - **Optional object tag** `GuardDutyMalwareScanStatus` with values `NO_THREATS_FOUND | THREATS_FOUND | UNSUPPORTED | ACCESS_DENIED | FAILED`. Tagging must be enabled on the plan before objects are uploaded.
    - https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html
  - **Delivery is at least once**, so duplicate results are possible. This matches rule 7: the consumer must be idempotent.
  - Skip reasons include `OBJECT_E_TAG_CHANGED`, `PASSWORD_PROTECTED` and `SSE_C_ENCRYPTED_OBJECT`. SSE-C objects cannot be scanned; SSE-KMS works if the role can decrypt.
    - https://docs.aws.amazon.com/guardduty/latest/ug/monitoring-malware-protection-s3-scans-gdu.html
- **Max object size:** 100 GB, not adjustable. Other quotas: 25 protected buckets per account per region, and up to 5 prefixes per bucket.
  - https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-quotas-guardduty.html
- **Impact:**
  - Keep GuardDuty as the quarantine scanner.
  - evidence-intake should trigger on the EventBridge Scan Result event and promote only on `COMPLETED` + `NO_THREATS_FOUND`.
  - Treat `UNSUPPORTED`, `ACCESS_DENIED`, `FAILED` and `THREATS_FOUND` as reject or hold.
  - Enable tagging and a TBAC deny-read policy on the quarantine bucket.
  - The GuardDuty IAM role needs `kms:Decrypt` on the quarantine key if that bucket uses SSE-KMS.

### 3. `@aws-sdk/s3-request-presigner` latest
**Verdict: CONFIRMED — 3.1152.0** (engines node >=20).
- https://www.npmjs.com/package/@aws-sdk/s3-request-presigner
- **Impact:** Pin `@aws-sdk/client-s3` to the same 3.x line.

---

## V-04 — CI / frontend

### 4. Environments with required reviewers on private repos
**Verdict: CORRECTED.** Only GitHub Enterprise (Cloud) supports this for private repositories.
- docs.github.com: "If you are on a GitHub Free, GitHub Pro, or GitHub Team plan, required reviewers are only available for public repositories." The same restriction applies to wait timers and custom deployment protection rules.
- Deployment branches/tags and environment variables work in private repos on Pro and Team. Environment secrets in private repos need Pro, Team or Enterprise.
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- **Impact:** "Manual approval on every deploy" via environment required reviewers is not possible on a private repo unless the plan is Enterprise Cloud (or the repo is public). See Design impacts.

### 5. Included minutes and Linux ARM64 runners
**Verdict: CONFIRMED.**
- **Included minutes/month for private repos:**
  - Free: 2,000 (artifact storage 500 MB)
  - Pro: 3,000 (1 GB)
  - Team: 3,000 (2 GB)
  - Enterprise Cloud: 50,000 (50 GB)
  - Public repos on standard runners are free.
  - https://docs.github.com/en/billing/concepts/product-billing/github-actions
- **Standard Linux arm64 runners for private repos:**
  - Labels: `ubuntu-24.04-arm`, `ubuntu-22.04-arm`, `ubuntu-26.04-arm`.
  - Size: 2 vCPU, 8 GB RAM, 14 GB SSD.
  - No plan restriction or preview note.
  - https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- **Price:**
  - Linux 2-core arm64: $0.005/min, cheaper than Linux 2-core x64 at $0.006/min. No minute multipliers are listed; billing is per-SKU rate.
  - Larger runners need Team or Enterprise Cloud.
  - https://docs.github.com/en/billing/reference/actions-runner-pricing
- **Impact:** Build ARM64 images natively on `ubuntu-24.04-arm` with no QEMU. The included minutes come off a shared pool, so 2,000 to 3,000 minutes must cover all pipelines.

### 6. Lambda Node.js 24 container base image
**Verdict: CONFIRMED.**
- The image is `public.ecr.aws/lambda/nodejs:24`: Node.js 24 on Amazon Linux 2023, with deprecation set for Apr 30, 2028. A `:26` image (Node 26) also exists.
  - https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html
  - https://gallery.ecr.aws/lambda/nodejs
- The registry manifest for tag `24` is a multi-arch list with `linux/arm64/v8` and `linux/amd64`. This was read from `public.ecr.aws/v2/lambda/nodejs/manifests/24`.
- AWS docs require `docker buildx build --platform linux/arm64 --provenance=false`.
- **Impact:** Use `FROM public.ecr.aws/lambda/nodejs:24`, preferably pinned by digest. CI must pass `--provenance=false`, or Lambda rejects the image index.

### 7. Latest npm versions

| Package | Latest | Notable peers / engines |
|---|---|---|
| oidc-client-ts | 3.5.0 | node >=18 |
| @tanstack/react-query | 5.104.5 | react ^18 \|\| ^19 |
| openapi-typescript | 7.13.0 | typescript ^5.x |
| openapi-fetch | 0.17.0 | — |
| react-router | 8.5.0 | react/react-dom >=19.2.7, node >=22.22.0 |
| @playwright/test | 1.64.1 | node >=20 |
| vite | 8.3.4 | node ^20.19.0 \|\| >=22.12.0 |
| react | 19.3.1 | — |

- **Verdict: CONFIRMED.** Source: https://registry.npmjs.org/<pkg>/latest.
- **Impact:**
  - react-router is now v8, so any spec text saying "v7" must be updated.
  - openapi-typescript declares peer `typescript ^5.x`, while npm `typescript` latest is 7.0.2 (see item 8).

---

## V-07

### 8. eslint-plugin-functional
**Verdict: CONFIRMED — 10.0.1** (published 2026-09-16).
- **Peer dependencies:** `eslint ^9.0.0 || ^10.0.0` and `typescript >=4.7.4` (optional). Engines: node >=20.
- **Dependencies:** `@typescript-eslint/utils ^8.26.0`, so it is on the typescript-eslint v8 line.
- **Flat config:** supported. GETTING_STARTED shows `eslint.config.js` with `defineConfig(..., tseslint.configs.recommendedTypeChecked, functional.configs.externalTypeScriptRecommended, functional.configs.recommended, ...)` and `projectService: true`.
- Sources:
  - https://www.npmjs.com/package/eslint-plugin-functional
  - https://github.com/eslint-functional/eslint-plugin-functional/blob/main/GETTING_STARTED.md
- **Related versions:**
  - eslint latest is 10.13.0.
  - typescript-eslint latest is 8.72.0, with peers `eslint ^8.57||^9||^10` and **`typescript >=4.8.4 <6.1.0`**.
  - typescript latest is **7.0.2**.
- **Impact:** Pin TypeScript to 6.0.x (or 5.x), not 7, until typescript-eslint and openapi-typescript support it. ESLint 9 or 10 with flat config is fine.

---

## Design impacts

1. **Manual deploy approval (CORRECTED).** GitHub environment required reviewers do not work on private repos under Free, Pro or Team. Pick one:
   - (a) Move to GitHub Enterprise Cloud.
   - (b) Make the repo public. This is not advised for a bank POC.
   - (c) Replace approval with a non-native gate, such as `workflow_dispatch`-only deploy jobs restricted to maintainers plus branch protection. That is weaker: no per-run approver audit trail.

   The "manual approval on every deploy" rule in CLAUDE.md §2 depends on this decision. Escalate it to the owner.
2. **Presigned PUT signing must be explicit.** Use `unhoistableHeaders: ["x-amz-checksum-sha256"]` and `signableHeaders: ["content-type","content-length"]`. Content-type is unsigned by default and would otherwise go unenforced.
   - The frontend must send `x-amz-checksum-sha256` (base64 of the raw digest), `Content-Type` and the exact length.
   - Quarantine-bucket CORS must allow those headers.
   - A range limit is not possible with PUT. The signed SHA-256 pins the exact bytes, so ADR-028 still holds.
3. **Verify checksum rejection on real S3.** Add a test proving S3 rejects a tampered body (BadDigest or SignatureDoesNotMatch). moto enforcement is UNVERIFIED.
   - Also assert that no empty-body CRC32 checksum is signed into the URL (SDK default since v3.729.0).
4. **GuardDuty Malware Protection for S3 is available in af-south-1.** Cost: $0.099/GB and $0.237 per 1,000 objects after the free tier.
   - Build evidence-intake on the EventBridge `GuardDuty Malware Protection Object Scan Result` event.
   - Tolerate duplicates (at-least-once delivery).
   - Promote only on `NO_THREATS_FOUND`. Enable tagging plus TBAC on quarantine.
5. **Lambda images.** Use `public.ecr.aws/lambda/nodejs:24` (multi-arch, arm64 present) and build with `--provenance=false`.
6. **Toolchain pins.** TypeScript must stay below 6.1 (typescript-eslint 8.72 peer), so do not adopt TS 7.0.2. react-router is v8 and requires react >=19.2.7 and Node >=22.22, which is fine on Node 24.
