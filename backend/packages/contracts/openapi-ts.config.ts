import { defineConfig, type UserConfig } from '@hey-api/openapi-ts';

const SPECS = [
  'auth.service',
  'users.public',
  'users.service',
  'transactions.public',
  'transactions.service',
  'disputes.public',
  'disputes.service',
] as const;

type ZodPluginConfig = Extract<NonNullable<UserConfig['plugins']>[number], { name: 'zod' }>;

const resolvers: NonNullable<ZodPluginConfig['$resolvers']> = {
  object(ctx) {
    const extra = ctx.schema.additionalProperties;
    if (extra !== false && extra?.type !== 'never') return undefined;
    return ctx.$(ctx.plugin.imports.z).attr('strictObject').call(ctx.nodes.shape(ctx));
  },
  string(ctx) {
    if (ctx.schema.format !== 'uuid') return undefined;
    return ctx.$(ctx.plugin.imports.z).attr('guid').call();
  },
};

export default defineConfig(
  SPECS.map((spec) => ({
    input: `../../../docs/openapi/${spec}.yaml`,
    output: { path: `src/${spec}`, clean: true, fileName: { suffix: '' } },
    plugins: [{ name: 'zod' as const, dates: { offset: true }, $resolvers: resolvers }],
  })),
);
