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
type StringResolver = NonNullable<NonNullable<ZodPluginConfig['$resolvers']>['string']>;
type StringContext = Parameters<StringResolver>[0];

// JSON Schema lengths count code points; zod's min/max count UTF-16 code units.
const codePointLengthCheck = ({ $, schema }: StringContext) => {
  const issue = (code: 'too_small' | 'too_big', bound: 'minimum' | 'maximum', limit: number) =>
    $('ctx')
      .attr('issues')
      .attr('push')
      .call(
        $.object()
          .prop('code', $.literal(code))
          .prop('origin', $.literal('string'))
          .prop(bound, $.literal(limit))
          .prop('inclusive', $.literal(true))
          .prop('input', $('ctx').attr('value')),
      );
  const { minLength, maxLength } = schema;
  const unitLength = $('ctx').attr('value').attr('length');
  const guards = [
    // A code point is at most 2 UTF-16 units, so more than 2 * max units is too long without spreading.
    maxLength === undefined
      ? []
      : [$.if(unitLength.gt($.literal(2 * maxLength))).do(issue('too_big', 'maximum', maxLength), $.return())],
    // A code point is at least 1 unit, so at most max units cannot exceed max code points.
    maxLength === undefined || minLength !== undefined
      ? []
      : [$.if(unitLength.lte($.literal(maxLength))).do($.return())],
  ].flat();
  const bounds = [
    minLength === undefined ? [] : [$.if($('length').lt($.literal(minLength))).do(issue('too_small', 'minimum', minLength))],
    maxLength === undefined ? [] : [$.if($('length').gt($.literal(maxLength))).do(issue('too_big', 'maximum', maxLength))],
  ].flat();
  return $.func()
    .arrow()
    .param('ctx')
    .do(...guards, $.const('length').assign($.array($.spread($('ctx').attr('value'))).attr('length')), ...bounds);
};

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
    const { format, maxLength, minLength, pattern } = ctx.schema;
    if (format === 'uuid') return ctx.$(ctx.plugin.imports.z).attr('guid').call();
    const hasLength = minLength !== undefined || maxLength !== undefined;
    const escaped = pattern === undefined ? undefined : escapeControlChars(pattern);
    if (!hasLength && escaped === pattern) return undefined;
    const base = ctx.nodes.format(ctx) ?? ctx.nodes.base(ctx);
    const checked = hasLength ? base.attr('check').call(codePointLengthCheck(ctx)) : base;
    if (escaped === undefined) return checked;
    const schema = { ...ctx.schema, pattern: escaped };
    return ctx.nodes.pattern({ ...ctx, schema, chain: { current: checked } }) ?? checked;
  },
};

export default defineConfig(
  SPECS.map((spec) => ({
    input: `../../../docs/openapi/${spec}.yaml`,
    output: { path: `src/${spec}`, clean: true, fileName: { suffix: '' } },
    plugins: [{ name: 'zod' as const, dates: { offset: true }, $resolvers: resolvers }],
  })),
);
