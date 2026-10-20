import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

export const bundleOptions: BuildOptions = {
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
};

if (import.meta.main) {
  await build({ ...bundleOptions, outfile: fileURLToPath(new URL('./dist/index.mjs', import.meta.url)) });
}
