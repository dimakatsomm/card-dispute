import * as z from 'zod';

type QueryOptions<S extends z.ZodObject> = { readonly csv?: readonly (keyof S['shape'] & string)[] };

const unwrap = (schema: z.ZodType): z.ZodType => {
  const inner = (schema._zod.def as { innerType?: z.ZodType }).innerType;
  return inner ? unwrap(inner) : schema;
};

const coerceField = (schema: z.ZodType, csv: boolean): z.ZodType => {
  switch (unwrap(schema)._zod.def.type) {
    case 'number':
      return z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), schema);
    case 'boolean':
      return z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), schema);
    case 'array':
      return z.preprocess((v) => (typeof v === 'string' ? (csv ? v.split(',') : [v]) : v), schema);
    default:
      return schema;
  }
};

// extend() keeps the source object's strict/loose mode.
export const queryOf = <S extends z.ZodObject>(schema: S, options: QueryOptions<S> = {}): S => {
  const csv: readonly string[] = options.csv ?? [];
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      coerceField(field as z.ZodType, csv.includes(key)),
    ]),
  );
  return schema.extend(shape) as unknown as S;
};
