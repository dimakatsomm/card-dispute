import type { DisputeDetail, Evidence } from '../../src/screens/dispute-detail/api';
import { json } from '../support/api';

export const transactionId = '0192f0c1-0000-7000-8000-0000000000t1';

export const evidenceItem = (overrides: Partial<Evidence> = {}): Evidence => ({
  evidenceId: '0192f0c1-0000-7000-8000-0000000000e1',
  fileName: 'receipt.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  status: 'STORED',
  ...overrides,
});

export const disputeDetail = (overrides: Partial<DisputeDetail> = {}): DisputeDetail => ({
  disputeId: '0192f0c1-0000-7000-8000-0000000000d1',
  transactionId,
  status: 'SUBMITTED',
  reasonCode: 'FRAUD',
  description: 'I did not make this purchase.',
  transaction: {
    accountId: '0192f0c1-0000-7000-8000-0000000000a1',
    cardId: '0192f0c1-0000-7000-8000-0000000000c1',
    amount: '125.50',
    currency: 'ZAR',
    merchantName: 'Corner Shop',
    transactionAt: '2026-09-01T10:00:00Z',
    postedAt: '2026-09-02T10:00:00Z',
  },
  evidence: [],
  version: 7,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  resolvedAt: null,
  resolutionNote: null,
  timeline: [{ type: 'SUBMITTED', at: '2026-10-01T10:00:00Z', by: 'CUSTOMER' }],
  ...overrides,
});

export const disputeResponse = (body: unknown, etag = '"7"'): Response => json(body, { headers: { ETag: etag } });

export const setTabVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};
