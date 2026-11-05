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

// openapi-ts unescapes every \uXXXX when printing, leaving raw control bytes that make the file binary to git.
const CONTROL_CHARS = /\p{Cc}/gu;
const hex2 = (code: number) => code.toString(16).padStart(2, '0');
const escapeControlChars = (pattern: string) =>
  pattern
    .replace(/\\u00([0-9a-fA-F]{2})/g, '\\x$1')
    .replace(CONTROL_CHARS, (c) => '\\x' + hex2(c.charCodeAt(0)));

const resolvers: NonNullable<ZodPluginConfig['$resolvers']> = {
  object(ctx) {
    const extra = ctx.schema.additionalProperties;
    if (extra !== false && extra?.type !== 'never') return undefined;
    return ctx.$(ctx.plugin.imports.z).attr('strictObject').call(ctx.nodes.shape(ctx));
  },
  string(ctx) {
    const { format, pattern } = ctx.schema;
    if (format === 'uuid') return ctx.$(ctx.plugin.imports.z).attr('guid').call();
    if (pattern === undefined) return undefined;
    const escaped = escapeControlChars(pattern);
    if (escaped === pattern) return undefined;
    const escapedCtx = { ...ctx, schema: { ...ctx.schema, pattern: escaped } };
    const { nodes, chain } = escapedCtx;
    chain.current = nodes.format(escapedCtx) ?? nodes.base(escapedCtx);
    const sizes = nodes.length(escapedCtx) ? [nodes.length] : [nodes.minLength, nodes.maxLength];
    for (const node of [...sizes, nodes.pattern]) chain.current = node(escapedCtx) ?? chain.current;
    return chain.current;
  },
};

export default defineConfig(
  SPECS.map((spec) => ({
    input: `../../../docs/openapi/${spec}.yaml`,
    output: { path: `src/${spec}`, clean: true, fileName: { suffix: '' } },
    plugins: [{ name: 'zod' as const, dates: { offset: true }, $resolvers: resolvers }],
  })),
);
