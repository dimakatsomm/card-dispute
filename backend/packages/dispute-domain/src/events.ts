import { err, ok, type Result } from '@cd/shared/fp';
import { z } from 'zod';
import { EVIDENCE_REJECTION_REASONS } from './evidence.ts';
import { REASON_CODES } from './reason-codes.ts';
import { DISPUTE_STATUSES } from './state-machine.ts';

export const EVENT_TYPES = Object.freeze([
  'DisputeCreated',
  'DisputeEdited',
  'DisputeStatusChanged',
  'EvidenceStored',
  'EvidenceRejected',
] as const);
export type EventType = (typeof EVENT_TYPES)[number];

const STATUS_EVENT_TYPES = Object.freeze(['DisputeCreated', 'DisputeEdited', 'DisputeStatusChanged'] as const);

// z.guid, not z.uuid: seeded ids are not RFC 9562 version-tagged (same as @cd/contracts).
const envelope = {
  eventId: z.guid(),
  occurredAt: z.iso.datetime({ offset: true }),
  disputeId: z.guid(),
  transactionId: z.guid(),
  userId: z.guid(),
  version: z.int().min(1),
};

const statusData = z
  .strictObject({
    fromStatus: z.enum(DISPUTE_STATUSES).nullable(),
    toStatus: z.enum(DISPUTE_STATUSES),
    reasonCode: z.enum(REASON_CODES),
  })
  .readonly();

const storedData = z.strictObject({ evidence: z.strictObject({ evidenceId: z.guid() }).readonly() }).readonly();

const rejectedData = z
  .strictObject({
    evidence: z.strictObject({ evidenceId: z.guid(), reason: z.enum(EVIDENCE_REJECTION_REASONS) }).readonly(),
  })
  .readonly();

const statusEvent = <T extends (typeof STATUS_EVENT_TYPES)[number]>(eventType: T) =>
  z.strictObject({ ...envelope, eventType: z.literal(eventType), data: statusData });

export const disputeEventSchema = z
  .discriminatedUnion('eventType', [
    statusEvent('DisputeCreated'),
    statusEvent('DisputeEdited'),
    statusEvent('DisputeStatusChanged'),
    z.strictObject({ ...envelope, eventType: z.literal('EvidenceStored'), data: storedData }),
    z.strictObject({ ...envelope, eventType: z.literal('EvidenceRejected'), data: rejectedData }),
  ])
  .readonly();

export type DisputeEvent = z.infer<typeof disputeEventSchema>;
export type DisputeCreated = Extract<DisputeEvent, { readonly eventType: 'DisputeCreated' }>;
export type DisputeEdited = Extract<DisputeEvent, { readonly eventType: 'DisputeEdited' }>;
export type DisputeStatusChanged = Extract<DisputeEvent, { readonly eventType: 'DisputeStatusChanged' }>;
export type EvidenceStored = Extract<DisputeEvent, { readonly eventType: 'EvidenceStored' }>;
export type EvidenceRejected = Extract<DisputeEvent, { readonly eventType: 'EvidenceRejected' }>;

// Paths and codes only: zod messages can echo input values, and events must never put PII in logs.
export type EventParseError = { readonly kind: 'INVALID_EVENT'; readonly issues: ReadonlyArray<string> };

export const parseDisputeEvent = (input: unknown): Result<DisputeEvent, EventParseError> => {
  const parsed = disputeEventSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err({
    kind: 'INVALID_EVENT',
    issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`),
  });
};

const isStatusEvent = (event: DisputeEvent): boolean =>
  (STATUS_EVENT_TYPES as ReadonlyArray<EventType>).includes(event.eventType);

// Evidence results never change the dispute version, so they are never stale (ADR-055).
export const isStaleEvent = (event: DisputeEvent, currentVersion: number): boolean =>
  isStatusEvent(event) && event.version < currentVersion;
