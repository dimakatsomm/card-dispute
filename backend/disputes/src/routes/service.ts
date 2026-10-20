import type { ServiceRoute } from '@cd/auth-client';
import {
  zLookupDisputesQuery,
  zRecordEvidenceResultBody,
  zRecordEvidenceResultPath,
  type zLookupDisputesResponse,
  type zRecordEvidenceResultResponse,
} from '@cd/contracts/disputes.service';
import { queryOf } from '@cd/contracts/query';
import { parseRequest, sendProblem, validationProblem } from '@cd/shared';
import { assertNever, type Result } from '@cd/shared/fp';
import type { z } from 'zod';
import type { ReportedResult } from '../core/evidence-result.ts';
import { recordEvidenceResultProblem } from '../errors.ts';
import type { DisputeRef } from '../use-cases/ports.ts';
import type { LookupDisputesInput } from '../use-cases/lookup-disputes.ts';
import type {
  RecordedEvidence,
  RecordEvidenceResultError,
  RecordEvidenceResultInput,
} from '../use-cases/record-evidence-result.ts';

type LookupResponse = z.output<typeof zLookupDisputesResponse>;
type RecordEvidenceResultResponse = z.output<typeof zRecordEvidenceResultResponse>;
type RecordEvidenceResultBody = z.output<typeof zRecordEvidenceResultBody>;

const lookupQuery = queryOf(zLookupDisputesQuery, { csv: ['transactionIds'] });

// The evidence result is a few hundred bytes; the 1 MiB default only invites abuse.
const EVIDENCE_RESULT_BODY_LIMIT_BYTES = 4 * 1024;

export type LookupDisputesUseCase = (
  input: LookupDisputesInput,
) => Promise<Result<ReadonlyArray<DisputeRef>, never>>;

export type RecordEvidenceResultUseCase = (
  input: RecordEvidenceResultInput,
) => Promise<Result<RecordedEvidence, RecordEvidenceResultError>>;

export type ServiceUseCases = {
  readonly lookupDisputes: LookupDisputesUseCase;
  readonly recordEvidenceResult: RecordEvidenceResultUseCase;
};

// Facts on a REJECTED body are informational only; disputes never acts on them.
const toReported = (body: RecordEvidenceResultBody): ReportedResult =>
  body.result === 'STORED'
    ? { result: 'STORED', sha256: body.sha256, sizeBytes: body.sizeBytes, contentType: body.contentType }
    : { result: 'REJECTED', reason: body.reason };

export const serviceRoutes = (useCases: ServiceUseCases): ReadonlyArray<ServiceRoute> => [
  {
    method: 'GET',
    url: '/disputes',
    scope: 'disputes/read',
    handler: async (request, reply) => {
      const query = parseRequest(lookupQuery, request.query);
      if (!query.ok) return sendProblem(reply, validationProblem(query.error, request.id));
      const result = await useCases.lookupDisputes(query.value);
      if (!result.ok) return assertNever(result.error);
      const body: LookupResponse = { items: [...result.value] };
      return reply.code(200).send(body);
    },
  },
  {
    method: 'PUT',
    url: '/dispute/:transactionId/evidence/:evidenceId',
    scope: 'disputes/evidence.write',
    bodyLimit: EVIDENCE_RESULT_BODY_LIMIT_BYTES,
    handler: async (request, reply) => {
      const path = parseRequest(zRecordEvidenceResultPath, request.params);
      if (!path.ok) return sendProblem(reply, validationProblem(path.error, request.id));
      const body = parseRequest(zRecordEvidenceResultBody, request.body);
      if (!body.ok) return sendProblem(reply, validationProblem(body.error, request.id));

      const result = await useCases.recordEvidenceResult({
        transactionId: path.value.transactionId,
        evidenceId: path.value.evidenceId,
        result: toReported(body.value),
        correlationId: request.id,
      });
      if (!result.ok) return sendProblem(reply, recordEvidenceResultProblem(result.error, request.id));
      const response: RecordEvidenceResultResponse = result.value;
      return reply.code(200).send(response);
    },
  },
];
