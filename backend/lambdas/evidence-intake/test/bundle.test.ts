import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { bundleOptions } from '../bundle.ts';

it('bundles the handler into one ESM file without fastify or the HTTP server', async () => {
  const { metafile, outputFiles } = await build({ ...bundleOptions, outfile: 'index.mjs', write: false, metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(metafile.inputs);
  expect(inputs.some((p) => p.includes('@aws-sdk/client-s3'))).toBe(true);
  expect(inputs.filter((p) => p.includes('fastify') || p.endsWith('/server.ts'))).toEqual([]);
  expect(outputFiles.map((f) => f.path.split(/[\\/]/).at(-1))).toEqual(['index.mjs']);
});
