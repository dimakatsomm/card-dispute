import { S3Client } from '@aws-sdk/client-s3';
import type { EvidenceViewResponse } from '@cd/dispute-domain';
import { createLogger, type Env } from '@cd/shared/lambda';
import { createEvidenceUrlSigner } from './adapters/evidence-url-signer.ts';
import { loadViewerConfig, type Config } from './config.ts';
import { createHandler } from './handler.ts';
import { mintEvidenceUrl } from './use-cases/mint-evidence-url.ts';

export type ViewerHandler = (event: unknown) => Promise<EvidenceViewResponse>;

export type Log = {
  readonly info: (obj: object, msg: string) => void;
  readonly error: (obj: object, msg: string) => void;
};

export type Runtime = {
  readonly s3: S3Client;
  readonly now: () => Date;
  readonly log: Log;
};

// Only an explicit AWS_ENDPOINT_URL may change the endpoint; any other configured endpoint is ignored so AWS URLs stay https.
export const createS3Client = (config: Config): S3Client =>
  new S3Client({
    region: config.AWS_REGION,
    ignoreConfiguredEndpointUrls: true,
    ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL, forcePathStyle: true } : {}),
  });

export const compose = (config: Config, runtime: Runtime): ViewerHandler =>
  createHandler(
    mintEvidenceUrl({
      presign: createEvidenceUrlSigner({ s3: runtime.s3, bucket: config.EVIDENCE_BUCKET }),
      now: runtime.now,
      allowPlainHttp: config.AWS_ENDPOINT_URL !== undefined,
      log: runtime.log,
    }),
    runtime.log,
  );

const init = (env: Env): ViewerHandler => {
  const config = loadViewerConfig(env);
  return compose(config, {
    s3: createS3Client(config),
    now: () => new Date(),
    log: createLogger({ level: config.LOG_LEVEL }),
  });
};

// Built on first invocation and reused while warm; a config error fails that invoke and is retried on the next.
export const createLambdaHandler = (env: Env): ViewerHandler => {
  let ready: ViewerHandler | undefined;
  return async (event) => {
    ready ??= init(env);
    return ready(event);
  };
};

export const handler = createLambdaHandler(process.env);
