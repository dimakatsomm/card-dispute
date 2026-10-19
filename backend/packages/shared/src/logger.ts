import pino from 'pino';

const REDACTED_KEYS = ['authorization', 'token', 'email', 'cellphoneNumber', 'name', 'surname', 'password'];

export const REDACT_PATHS: ReadonlyArray<string> = [
  ...REDACTED_KEYS,
  ...REDACTED_KEYS.map((k) => `*.${k}`),
  'secret',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
];

export type LoggerOptions = {
  readonly level?: string;
  readonly destination?: pino.DestinationStream;
};

export const createLogger = (options: LoggerOptions = {}): pino.Logger =>
  pino(
    { level: options.level ?? 'info', redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' } },
    options.destination,
  );
