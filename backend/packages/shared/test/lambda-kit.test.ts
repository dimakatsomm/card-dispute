import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as lambda from '../src/lambda.ts';
import { emitMetric } from '../src/emf.ts';
import { createSecretResolver, type SecretsClient } from '../src/secrets.ts';

describe('@cd/shared/lambda', () => {
  it('re-exports config, logger and correlation helpers', () => {
    expect(lambda).toMatchObject({
      loadConfig: expect.any(Function),
      createLogger: expect.any(Function),
      resolveCorrelationId: expect.any(Function),
      CORRELATION_HEADER: 'x-correlation-id',
      emitMetric: expect.any(Function),
      createSecretResolver: expect.any(Function),
    });
  });

  it('bundles without fastify or server.ts', async () => {
    const { metafile } = await build({
      entryPoints: [fileURLToPath(new URL('../src/lambda.ts', import.meta.url))],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.length).toBeGreaterThan(5);
    expect(inputs.filter((p) => p.includes('fastify') || p.endsWith('/server.ts'))).toEqual([]);
  });
});

describe('emitMetric', () => {
  it('writes the EMF shape used by EventPublishFailed', () => {
    const lines: object[] = [];
    emitMetric(
      { info: (obj) => lines.push(obj) },
      { namespace: 'cd/disputes', name: 'EventPublishFailed', timestamp: 1700, dimensions: { eventType: 'DisputeCreated' } },
    );
    expect(lines).toEqual([
      {
        _aws: {
          Timestamp: 1700,
          CloudWatchMetrics: [
            {
              Namespace: 'cd/disputes',
              Dimensions: [['eventType']],
              Metrics: [{ Name: 'EventPublishFailed', Unit: 'Count' }],
            },
          ],
        },
        eventType: 'DisputeCreated',
        EventPublishFailed: 1,
      },
    ]);
  });

  it('supports a metric without dimensions and an explicit value', () => {
    const lines: Array<Record<string, unknown>> = [];
    emitMetric({ info: (obj) => lines.push(obj as Record<string, unknown>) }, { namespace: 'n', name: 'RetentionErased', timestamp: 1, value: 3 });
    expect(lines[0]).toMatchObject({ RetentionErased: 3 });
    expect(JSON.stringify(lines[0])).toContain('"Dimensions":[[]]');
  });
});

describe('createSecretResolver', () => {
  const clientReturning = (result: () => unknown): SecretsClient => ({
    send: () => Promise.resolve().then(result) as ReturnType<SecretsClient['send']>,
  });

  it('returns the secret string and asks for the given id', async () => {
    const seen: unknown[] = [];
    const client: SecretsClient = {
      send: (command) => {
        seen.push(command.input);
        return Promise.resolve({ SecretString: 's3cret', $metadata: {} });
      },
    };
    expect(await createSecretResolver(client)('db/url')).toEqual({ ok: true, value: 's3cret' });
    expect(seen).toEqual([{ SecretId: 'db/url' }]);
  });

  it('returns not_found for a missing secret or one without a string, without throwing', async () => {
    const missing = clientReturning(() => {
      throw Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' });
    });
    const binary = clientReturning(() => ({ $metadata: {} }));
    expect(await createSecretResolver(missing)('a')).toEqual({ ok: false, error: { kind: 'not_found', secretId: 'a' } });
    expect(await createSecretResolver(binary)('b')).toEqual({ ok: false, error: { kind: 'not_found', secretId: 'b' } });
  });

  it('returns unavailable for any other failure and never leaks the cause', async () => {
    const down = clientReturning(() => {
      throw new Error('AccessDenied for arn:secret-value-xyz');
    });
    const res = await createSecretResolver(down)('c');
    expect(res).toEqual({ ok: false, error: { kind: 'unavailable', secretId: 'c' } });
  });
});
