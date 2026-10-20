// Restricted-syntax/import rules replace rather than merge across matching blocks, so each block lists its full set.
import { builtinModules } from 'node:module';
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const SERVICES = ['auth', 'users', 'transactions', 'disputes'];
const LAMBDAS = ['evidence-intake', 'dispute-notifier', 'retention-sweeper'];
const PACKAGES = ['shared', 'auth-client', 'dispute-domain', 'db', 'contracts'];
const LAYERS = ['core', 'use-cases', 'routes'];

const NO_CLASSES = [
  {
    selector: 'ClassDeclaration',
    message: 'Classes are banned in backend/ and frontend/: use functions and closures (ADR-038).',
  },
  {
    selector: 'ClassExpression',
    message: 'Classes are banned in backend/ and frontend/: use functions and closures (ADR-038).',
  },
];

const NO_CLOCK = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Date.now() is banned in core/ and dispute-domain: inject the clock (ADR-038).',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'new Date() without arguments is banned in core/ and dispute-domain: inject the clock (ADR-038).',
  },
];

const group = (patterns, message) => ({ group: patterns, message });

const LAYER_RULES = {
  core: group(
    ['**/adapters', '**/adapters/**', '**/use-cases', '**/use-cases/**', '**/routes', '**/routes/**'],
    'core/ must not import adapters, use-cases or routes (ADR-038).',
  ),
  'use-cases': group(
    ['**/adapters', '**/adapters/**'],
    'use-cases/ must not import adapters: receive them as deps (ADR-038).',
  ),
  routes: group(
    ['**/adapters', '**/adapters/**'],
    'routes/ must not import adapters: receive use-cases from main.ts (ADR-038).',
  ),
};

const deployables = [
  ...SERVICES.map((name) => ({ name, dir: `backend/${name}` })),
  ...LAMBDAS.map((name) => ({ name, dir: `backend/lambdas/${name}` })),
];

const otherDeployables = (self) =>
  deployables
    .filter((d) => d.name !== self)
    .map((d) =>
      group(
        [
          `@cd/${d.name}`,
          `@cd/${d.name}/**`,
          `**/backend/${d.name}/**`,
          `**/backend/lambdas/${d.name}/**`,
          `**/${d.name}/src/**`,
        ],
        `A service may import only backend/packages/*, never ${d.name}'s folder (ADR-029). Use HTTP.`,
      ),
    );

const foreignPublicContracts = (self) =>
  SERVICES.filter((name) => name !== self).map((name) =>
    group(
      [`@cd/contracts/${name}.public`],
      `A deployable may import only its own *.public contract and callees' *.service contracts, never ${name}.public (ADR-057).`,
    ),
  );

const restrictedFor = (self) => [
  ...otherDeployables(self),
  ...(SERVICES.includes(self)
    ? foreignPublicContracts(self)
    : [
        group(
          SERVICES.map((name) => `@cd/contracts/${name}.public`),
          'Lambdas call service ports: import *.service contracts only, never a *.public contract (ADR-057).',
        ),
      ]),
];

const importRule = (patterns, paths = []) => ({
  'no-restricted-imports': ['error', { patterns, paths }],
});

const ADAPTERS_ONLY_IN_MAIN = group(
  ['**/adapters', '**/adapters/**'],
  'Only main.ts imports adapters: everything else receives them as deps (ADR-038).',
);

const PURE_MESSAGE = 'core/ is pure: no I/O or framework modules; time and ids are injected (ADR-038).';
const PURE_PATHS = [
  ...builtinModules,
  'pg',
  'fastify',
  'pino',
  '@cd/shared',
  '@cd/auth-client',
  '@cd/db',
].map((name) => ({ name, message: PURE_MESSAGE }));
const PURE_PATTERNS = [
  group(
    ['node:*', '@aws-sdk/*', '@cd/auth-client/**', '@cd/db/**', '@cd/shared/*', '!@cd/shared/fp'],
    PURE_MESSAGE,
  ),
];
const pureImportRule = (patterns) => importRule([...patterns, ...PURE_PATTERNS], PURE_PATHS);

const deployableBlocks = deployables.flatMap(({ name, dir }) => [
  { files: [`${dir}/**/*.ts`], rules: importRule(restrictedFor(name)) },
  {
    files: [`${dir}/src/**/*.ts`],
    ignores: [`${dir}/src/main.ts`, `${dir}/src/adapters/**`],
    rules: importRule([...restrictedFor(name), ADAPTERS_ONLY_IN_MAIN]),
  },
  ...LAYERS.map((layer) => {
    const patterns = [...restrictedFor(name), LAYER_RULES[layer]];
    return {
      files: [`${dir}/src/${layer}/**/*.ts`],
      rules: layer === 'core' ? pureImportRule(patterns) : importRule(patterns),
    };
  }),
]);

const frontendRule = importRule([
  group(
    [
      '**/backend',
      '**/backend/**',
      ...[...SERVICES, ...LAMBDAS, ...PACKAGES].flatMap((n) => [`@cd/${n}`, `@cd/${n}/**`]),
    ],
    'frontend/ must not import anything from backend/: use types generated from docs/openapi (ADR-029).',
  ),
]);

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'infra/**',
      'tools/lint-rules-test/fixtures/**',
      'backend/packages/contracts/src/*/**',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'no-param-reassign': ['error', { props: true }],
      'prefer-const': 'error',
    },
  },
  {
    files: ['backend/**/*.{ts,tsx}', 'frontend/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...NO_CLASSES] },
  },
  {
    files: [
      'backend/*/src/core/**/*.ts',
      'backend/lambdas/*/src/core/**/*.ts',
      'backend/packages/dispute-domain/**/*.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...NO_CLASSES, ...NO_CLOCK] },
  },
  ...deployableBlocks,
  {
    files: ['backend/packages/**/*.ts'],
    rules: importRule(otherDeployables(null)),
  },
  {
    files: ['backend/packages/dispute-domain/**/*.ts'],
    rules: pureImportRule(otherDeployables(null)),
  },
  { files: ['frontend/**/*.{ts,tsx}'], rules: frontendRule },
);
