import type { HttpClient, ServiceTokenProvider } from '@cd/auth-client/service-client';
import {
  zRecordEvidenceResultBody,
  zRecordEvidenceResultPath,
  zRecordEvidenceResultResponse,
} from '@cd/contracts/disputes.service';
import { err, ok, type Result } from '@cd/shared/fp';
import { z } from 'zod';
import type { EvidenceResult } from '../core/decide.ts';
import type { DisputesError, EvidenceRef, IntakeLog, RecordOutcome } from '../use-cases/process-evidence.ts';

export const UPSTREAM_DEADLINE_MS = 2000;

export type DisputesClientDeps = {
  readonly baseUrl: string;
  readonly http: HttpClient;
  readonly tokens: ServiceTokenProvider;
  readonly log: IntakeLog;
  readonly timeoutMs: number;
};

const withDeadline = async <T>(ms: number, work: Promise<T>, onTimeout: () => T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const evidenceKey = (evidenceId: string): RegExp =>
  new RegExp(`^evidence/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/${evidenceId}$`);

const conflictProblem = z.object({ code: z.enum(['EVIDENCE_CLOSED', 'RESULT_CONFLICT']) });

// Only a closed slot may be cleaned up; a conflict or an unrecognised 409 keeps the object for an operator.
const interpretConflict = (body: unknown): Result<RecordOutcome, DisputesError> => {
  const parsed = conflictProblem.safeParse(body);
  if (!parsed.success) return err('UNKNOWN_CONFLICT');
  return parsed.data.code === 'EVIDENCE_CLOSED' ? ok({ kind: 'closed' }) : err('RESULT_CONFLICT');
};

const interpret = (ref: EvidenceRef, body: unknown): Result<RecordOutcome, DisputesError> => {
  const parsed = zRecordEvidenceResultResponse.safeParse(body);
  if (!parsed.success || parsed.data.evidenceId !== ref.evidenceId) return err('BAD_RESPONSE');
  if (parsed.data.status === 'REJECTED') return ok({ kind: 'recorded', status: 'REJECTED' });
  // The copy target comes from disputes; pinning its shape keeps a bad answer from writing anywhere else.
  const { s3Key } = parsed.data;
  return s3Key && evidenceKey(ref.evidenceId).test(s3Key)
    ? ok({ kind: 'recorded', status: 'STORED', s3Key })
    : err('BAD_RESPONSE');
};

const put = async (
  deps: DisputesClientDeps,
  url: string,
  ref: EvidenceRef,
  body: string,
  correlationId: string,
  signal: AbortSignal,
  mayRetry = true,
): Promise<Result<RecordOutcome, DisputesError>> => {
  const token = await deps.tokens.getToken();
  if (!token.ok) {
    deps.log.warn({ correlationId, detail: token.error.detail }, 'service token unavailable');
    return err('UNAVAILABLE');
  }
  const res = await deps.http.request({
    url,
    method: 'PUT',
    headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
    body,
    correlationId,
    signal,
  });
  if (!res.ok) {
    deps.log.warn({ correlationId, kind: res.error.kind }, 'disputes call failed');
    return err('UNAVAILABLE');
  }
  const { status } = res.value;
  if (status === 401 && mayRetry) {
    deps.tokens.invalidate(token.value);
    return put(deps, url, ref, body, correlationId, signal, false);
  }
  if (status === 200) return interpret(ref, res.value.body);
  if (status === 409) return interpretConflict(res.value.body);
  deps.log.warn({ correlationId, status }, 'disputes refused the evidence result');
  return err(status === 404 ? 'NOT_FOUND' : 'REFUSED');
};

// One budget covers token + request + the 401 retry (ADR-054).
export const createDisputesClient = (deps: DisputesClientDeps) => ({
  recordResult: (
    ref: EvidenceRef,
    result: EvidenceResult,
    correlationId: string,
  ): Promise<Result<RecordOutcome, DisputesError>> => {
    const path = zRecordEvidenceResultPath.parse(ref);
    const body = JSON.stringify(zRecordEvidenceResultBody.parse(result));
    const url = `${deps.baseUrl}/dispute/${path.transactionId}/evidence/${path.evidenceId}`;
    const controller = new AbortController();
    return withDeadline(deps.timeoutMs, put(deps, url, ref, body, correlationId, controller.signal), () => {
      controller.abort();
      deps.log.warn({ correlationId, timeoutMs: deps.timeoutMs }, 'disputes deadline exceeded');
      return err('UNAVAILABLE');
    });
  },
});
