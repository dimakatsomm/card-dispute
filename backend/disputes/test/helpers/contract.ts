import {
  zAddEvidenceResponse,
  zCreateDisputeResponse,
  zGetDisputeResponse,
  zListMyDisputesResponse,
  zUpdateDisputeResponse,
} from '@cd/contracts/disputes.public';
import { zLookupDisputesResponse } from '@cd/contracts/disputes.service';
import { expect } from 'vitest';

const RESPONSES = {
  create: zCreateDisputeResponse,
  addEvidence: zAddEvidenceResponse,
  update: zUpdateDisputeResponse,
  list: zListMyDisputesResponse,
  detail: zGetDisputeResponse,
  lookup: zLookupDisputesResponse,
} as const;

// Public responses are strict, so an extra field fails here as well as a missing or malformed one (ADR-057).
export const expectContract = (response: keyof typeof RESPONSES, body: unknown): void => {
  expect(RESPONSES[response].safeParse(body).error?.issues ?? []).toEqual([]);
};
