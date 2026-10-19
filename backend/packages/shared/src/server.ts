import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { correlationServerOptions, registerCorrelation } from './correlation.ts';
import { createLogger } from './logger.ts';
import { commonProblem, PROBLEMS, problemBody, sendProblem, type ProblemBody } from './problem.ts';

export type RegisterRoutes = (app: FastifyInstance) => void | Promise<void>;

export type ServersOptions = {
  readonly public: RegisterRoutes;
  readonly service: RegisterRoutes;
  readonly ports?: { readonly public: number; readonly service: number };
  readonly logger?: FastifyBaseLogger;
  readonly ready?: () => Promise<boolean>;
  readonly newId?: () => string;
};

export type Servers = {
  readonly public: FastifyInstance;
  readonly service: FastifyInstance;
  readonly listen: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const DEFAULT_PORTS = { public: 8080, service: 8081 } as const;

const alwaysReady = async (): Promise<boolean> => true;

const CLIENT_ERROR_CODES: Readonly<Record<number, keyof typeof PROBLEMS>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
};

// Keeps the framework's status (413, 415, 429, ...) with a generic body that never echoes input.
const clientErrorProblem = (status: number, correlationId: string): ProblemBody => {
  const known = CLIENT_ERROR_CODES[status];
  return known
    ? commonProblem(known, 'Request rejected', correlationId)
    : problemBody({
        status,
        title: STATUS_CODES[status] ?? 'Client Error',
        code: `HTTP_${status}`,
        detail: 'Request rejected',
        correlationId,
      });
};

const buildServer = (
  register: RegisterRoutes,
  options: Pick<ServersOptions, 'logger' | 'ready' | 'newId'>,
): FastifyInstance => {
  const app = Fastify({
    loggerInstance: options.logger ?? createLogger(),
    ...correlationServerOptions(options.newId ?? randomUUID),
  });
  registerCorrelation(app);

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, commonProblem('NOT_FOUND', 'Route not found', request.id)),
  );
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendProblem(reply, clientErrorProblem(status, request.id));
    }
    request.log.error({ err: error }, 'unhandled error');
    return sendProblem(reply, commonProblem('INTERNAL_ERROR', 'Unexpected error', request.id));
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (request, reply) => {
    const isReady = await (options.ready ?? alwaysReady)().catch((err: unknown) => {
      request.log.warn({ err }, 'readiness check failed');
      return false;
    });
    return isReady
      ? { status: 'ready' }
      : sendProblem(reply, commonProblem('NOT_READY', 'Dependencies not ready', request.id));
  });

  void app.register(async (instance) => {
    await register(instance);
  });
  return app;
};

export const createServers = (options: ServersOptions): Servers => {
  const ports = options.ports ?? DEFAULT_PORTS;
  const publicApp = buildServer(options.public, options);
  const serviceApp = buildServer(options.service, options);
  return {
    public: publicApp,
    service: serviceApp,
    listen: async () => {
      try {
        await Promise.all([
          publicApp.listen({ port: ports.public, host: '0.0.0.0' }),
          serviceApp.listen({ port: ports.service, host: '0.0.0.0' }),
        ]);
      } catch (error) {
        await Promise.all([publicApp.close(), serviceApp.close()]);
        throw error;
      }
    },
    close: async () => {
      await Promise.all([publicApp.close(), serviceApp.close()]);
    },
  };
};
