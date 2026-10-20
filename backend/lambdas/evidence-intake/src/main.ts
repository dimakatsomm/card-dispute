import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHttpClient, createServiceTokenProvider, type Fetch } from '@cd/auth-client/service-client';
import { createSecretResolver, emitMetric, type SecretsClient } from '@cd/shared/lambda';
import { clientSecretSource, resolveClientSecret } from './adapters/client-secret.ts';
import { createDisputesClient, UPSTREAM_DEADLINE_MS } from './adapters/disputes-client.ts';
import { createQuarantineStore } from './adapters/quarantine-store.ts';
import type { Config } from './config.ts';
import { createHandler } from './handler.ts';
import { processEvidence } from './use-cases/process-evidence.ts';

export const DISPUTES_SCOPE = 'disputes/evidence.write';
export const METRIC_NAMESPACE = 'cd/evidence-intake';

export type Log = {
  readonly info: (obj: object, msg?: string) => void;
  readonly warn: (obj: object, msg: string) => void;
  readonly error: (obj: object, msg: string) => void;
};

export type Runtime = {
  readonly s3: Pick<S3Client, 'send'>;
  readonly secrets: () => SecretsClient;
  readonly fetch: Fetch;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly log: Log;
  readonly timeoutMs?: number;
};

export const awsRuntime = (config: Config, log: Log): Runtime => ({
  s3: new S3Client({
    region: config.AWS_REGION,
    ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL, forcePathStyle: true } : {}),
  }),
  secrets: () => new SecretsManagerClient({ region: config.AWS_REGION }),
  fetch: globalThis.fetch,
  now: () => new Date(),
  newId: randomUUID,
  log,
});

export const compose = async (config: Config, runtime: Runtime) => {
  const clientSecret = await resolveClientSecret(clientSecretSource(config), () =>
    createSecretResolver(runtime.secrets()),
  );
  const tokens = createServiceTokenProvider({
    tokenUrl: config.TOKEN_URL,
    clientId: config.SERVICE_CLIENT_ID,
    clientSecret,
    scopes: [DISPUTES_SCOPE],
    fetch: runtime.fetch,
    now: () => runtime.now().getTime(),
  });
  const timeoutMs = runtime.timeoutMs ?? UPSTREAM_DEADLINE_MS;
  const disputes = createDisputesClient({
    baseUrl: config.DISPUTES_SERVICE_URL.replace(/\/+$/, ''),
    http: createHttpClient({ fetch: runtime.fetch, timeoutMs }),
    tokens,
    log: runtime.log,
    timeoutMs,
  });
  const intake = processEvidence({
    quarantineBucket: config.QUARANTINE_BUCKET,
    requireScan: config.EVIDENCE_REQUIRE_SCAN,
    quarantine: createQuarantineStore({
      s3: runtime.s3,
      quarantineBucket: config.QUARANTINE_BUCKET,
      evidenceBucket: config.EVIDENCE_BUCKET,
    }),
    recordResult: disputes.recordResult,
    notScanned: () =>
      emitMetric(runtime.log, {
        namespace: METRIC_NAMESPACE,
        name: 'EvidenceNotScanned',
        timestamp: runtime.now().getTime(),
      }),
    resultConflict: () =>
      emitMetric(runtime.log, {
        namespace: METRIC_NAMESPACE,
        name: 'EvidenceResultConflict',
        timestamp: runtime.now().getTime(),
      }),
    newId: runtime.newId,
    log: runtime.log,
  });
  return createHandler(intake, runtime.log);
};
