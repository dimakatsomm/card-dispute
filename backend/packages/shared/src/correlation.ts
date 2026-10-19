import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

export const CORRELATION_HEADER = 'x-correlation-id';

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

// Inbound ids reach log lines and response headers, so anything off-pattern is replaced (log injection).
export const resolveCorrelationId = (inbound: unknown, newId: () => string): string =>
  typeof inbound === 'string' && VALID_ID.test(inbound) ? inbound : newId();

export const correlationServerOptions = (newId: () => string) =>
  ({
    requestIdHeader: false,
    childLoggerFactory: (logger: FastifyBaseLogger, bindings: { readonly reqId?: unknown }, opts: object) =>
      logger.child({ correlationId: bindings.reqId }, opts),
    genReqId: (req: { readonly headers: Readonly<Record<string, unknown>> }) =>
      resolveCorrelationId(req.headers[CORRELATION_HEADER], newId),
  }) as const;

export const registerCorrelation = (app: FastifyInstance): void => {
  app.addHook('onRequest', async (request, reply) => {
    reply.header(CORRELATION_HEADER, request.id);
  });
};
