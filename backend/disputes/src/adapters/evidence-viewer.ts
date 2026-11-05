import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { evidenceViewRequestSchema, evidenceViewResponseSchema } from '@cd/dispute-domain';
import { err, ok, type Result } from '@cd/shared/fp';
import type { FastifyBaseLogger } from 'fastify';
import type { InvokeViewer, ViewerError } from '../use-cases/ports.ts';
import { summarizeError, withDeadline } from './deadline.ts';

// Covers a container-image cold start; the viewer itself only signs locally.
export const VIEWER_TIMEOUT_MS = 5000;

export type LambdaInvokeInput = {
  readonly FunctionName: string;
  readonly InvocationType: 'RequestResponse';
  readonly Payload: Uint8Array;
};

export type LambdaInvokeOutput = { readonly FunctionError?: string; readonly Payload?: Uint8Array };

export type LambdaInvoke = (
  input: LambdaInvokeInput,
  abortSignal: AbortSignal,
) => Promise<LambdaInvokeOutput>;

export const createLambdaInvoke = (options: {
  readonly region: string;
  readonly endpoint?: string;
  readonly timeoutMs: number;
}): LambdaInvoke => {
  const client = new LambdaClient({
    region: options.region,
    // One attempt inside one deadline; the agent can simply ask again.
    maxAttempts: 1,
    requestHandler: { requestTimeout: options.timeoutMs, connectionTimeout: options.timeoutMs },
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  });
  return async (input, abortSignal) => {
    const out = await client.send(new InvokeCommand({ ...input }), { abortSignal });
    return {
      ...(out.FunctionError === undefined ? {} : { FunctionError: out.FunctionError }),
      ...(out.Payload === undefined ? {} : { Payload: out.Payload }),
    };
  };
};

type Failure = { readonly reason: string; readonly error?: unknown };

const parseReply = (out: LambdaInvokeOutput): Result<unknown, Failure> => {
  // The function error payload may echo request details; only its presence is logged.
  if (out.FunctionError !== undefined) return err({ reason: 'FUNCTION_ERROR' });
  if (out.Payload === undefined) return err({ reason: 'EMPTY_REPLY' });
  try {
    return ok(JSON.parse(new TextDecoder().decode(out.Payload)) as unknown);
  } catch {
    return err({ reason: 'MALFORMED_REPLY' });
  }
};

export const createLambdaViewer = (deps: {
  readonly invoke: LambdaInvoke;
  readonly functionName: string;
  readonly timeoutMs: number;
  readonly log: FastifyBaseLogger;
}): InvokeViewer => {
  const invokeOnce = async (payload: Uint8Array): Promise<Result<LambdaInvokeOutput, Failure>> => {
    const abort = new AbortController();
    return withDeadline(
      deps.timeoutMs,
      deps
        .invoke(
          { FunctionName: deps.functionName, InvocationType: 'RequestResponse', Payload: payload },
          abort.signal,
        )
        .then(ok, (error: unknown) => err<Failure>({ reason: 'INVOKE_FAILED', error })),
      () => {
        abort.abort();
        return err({ reason: 'TIMEOUT' });
      },
    );
  };

  return async (request) => {
    const fail = (failure: Failure): Result<never, ViewerError> => {
      deps.log.error(
        {
          disputeId: request.disputeId,
          evidenceId: request.evidenceId,
          reason: failure.reason,
          ...(failure.error === undefined ? {} : { error: summarizeError(failure.error) }),
        },
        'evidence viewer failed',
      );
      return err('VIEWER_UNAVAILABLE');
    };

    const parsedRequest = evidenceViewRequestSchema.safeParse(request);
    if (!parsedRequest.success) return fail({ reason: 'INVALID_REQUEST' });
    const out = await invokeOnce(new TextEncoder().encode(JSON.stringify(parsedRequest.data)));
    if (!out.ok) return fail(out.error);
    const body = parseReply(out.value);
    if (!body.ok) return fail(body.error);
    const reply = evidenceViewResponseSchema.safeParse(body.value);
    return reply.success ? ok(reply.data) : fail({ reason: 'INVALID_REPLY' });
  };
};

export const unconfiguredViewer =
  (log: FastifyBaseLogger): InvokeViewer =>
  async (request) => {
    log.error(
      { disputeId: request.disputeId, evidenceId: request.evidenceId },
      'evidence viewer not configured',
    );
    return err('VIEWER_UNAVAILABLE');
  };
