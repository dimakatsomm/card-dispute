import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as serviceClient from '../src/service-client.ts';

it('service-client exports the token provider and HTTP client only', () => {
  expect(Object.keys(serviceClient).sort()).toEqual(['createHttpClient', 'createServiceTokenProvider']);
});

it('service-client bundles without fastify or shared server.ts', async () => {
  const { metafile } = await build({
    entryPoints: [fileURLToPath(new URL('../src/service-client.ts', import.meta.url))],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  const inputs = Object.keys(metafile.inputs);
  expect(inputs.length).toBeGreaterThan(2);
  expect(inputs.filter((p) => p.includes('fastify') || p.endsWith('/server.ts'))).toEqual([]);
});
