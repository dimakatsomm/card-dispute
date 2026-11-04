import type { QueueItem } from '../../src/screens/agent-queue/api';
import type { AgentDispute } from '../../src/screens/agent-dispute/api';

export const agentTransactionId = '0192f0c1-0000-7000-8000-0000000000t9';
export const digestA = 'a'.repeat(64);
export const digestB = 'b'.repeat(64);

export const queueItem = (n: number, overrides: Partial<QueueItem> = {}): QueueItem => ({
  disputeId: `0192f0c1-0000-7000-8000-00000000d${String(n).padStart(3, '0')}`,
  transactionId: `0192f0c1-0000-7000-8000-00000000t${String(n).padStart(3, '0')}`,
  status: 'SUBMITTED',
  reasonCode: 'FRAUD',
  version: 1,
  createdAt: '2026-10-01T10:00:00Z',
  pickedUpBy: null,
  ...overrides,
});

export const agentDispute = (overrides: Partial<AgentDispute> = {}): AgentDispute => ({
  disputeId: '0192f0c1-0000-7000-8000-0000000000d9',
  transactionId: agentTransactionId,
  status: 'SUBMITTED',
  reasonCode: 'NOT_RECEIVED',
  description: 'The parcel never arrived.',
  transaction: {
    accountId: '0192f0c1-0000-7000-8000-0000000000a1',
    cardId: '0192f0c1-0000-7000-8000-0000000000c1',
    amount: '980.00',
    currency: 'ZAR',
    merchantName: 'Parcel Store',
    transactionAt: '2026-09-20T10:00:00Z',
    postedAt: '2026-09-21T10:00:00Z',
  },
  evidence: [],
  evidenceDigest: digestA,
  version: 3,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  resolvedAt: null,
  resolutionNote: null,
  pickedUpBy: null,
  timeline: [{ type: 'SUBMITTED', at: '2026-10-01T10:00:00Z', by: 'CUSTOMER' }],
  ...overrides,
});
