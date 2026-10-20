import type { DisputeStatus } from '@cd/dispute-domain';
import { assertNever } from '@cd/shared/fp';
import type {
  DisputeSummary,
  EvidenceRecord,
  HistoryAction,
  HistoryRecord,
  TimelineEvent,
} from './types.ts';

export const REJECTION_REASONS = ['MALWARE', 'TYPE_MISMATCH', 'CHECKSUM', 'SIZE'] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type EvidenceDetail = EvidenceRecord & { readonly rejectionReason: RejectionReason | null };

export type TimelineType = TimelineEvent['type'];

export type TimelineBy = TimelineEvent['by'];

export type EditedField = 'description' | 'reasonCode';

export type TimelineDetail = NonNullable<TimelineEvent['detail']>;

export type LastEvent = DisputeSummary['lastEvent'];

const EDITED_FIELDS: ReadonlyArray<EditedField> = ['description', 'reasonCode'];

// Attribution follows the event, never the actor row, so agent and rule identities cannot leak (docs/02).
const BY: Readonly<Record<TimelineType, TimelineBy>> = {
  SUBMITTED: 'CUSTOMER',
  EDITED: 'CUSTOMER',
  EVIDENCE_ADDED: 'CUSTOMER',
  WITHDRAWN: 'CUSTOMER',
  EVIDENCE_REJECTED: 'BANK',
  UNDER_REVIEW: 'BANK',
  RESOLVED_ACCEPTED: 'BANK',
  RESOLVED_REJECTED: 'BANK',
};

export const timelineTypeOf = (action: HistoryAction, toStatus: DisputeStatus): TimelineType | null => {
  switch (action) {
    case 'CREATE':
      return 'SUBMITTED';
    case 'EDIT':
      return 'EDITED';
    case 'EVIDENCE_ADDED':
    case 'EVIDENCE_REJECTED':
      return action;
    case 'REVIEW':
      return 'UNDER_REVIEW';
    case 'WITHDRAW':
      return 'WITHDRAWN';
    case 'RESOLVE':
      return toStatus === 'RESOLVED_ACCEPTED' || toStatus === 'RESOLVED_REJECTED' ? toStatus : null;
    default:
      return assertNever(action);
  }
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const editedFields = (after: unknown): ReadonlyArray<EditedField> => {
  const changed = asRecord(after);
  return changed === null ? [] : EDITED_FIELDS.filter((f) => f in changed);
};

const evidenceFor = (after: unknown, evidence: ReadonlyArray<EvidenceDetail>): EvidenceDetail | undefined => {
  const evidenceId = asRecord(after)?.evidenceId;
  return typeof evidenceId === 'string' ? evidence.find((e) => e.evidenceId === evidenceId) : undefined;
};

const evidenceDetail = (type: TimelineType, item: EvidenceDetail | undefined): TimelineDetail | undefined => {
  if (item === undefined) return undefined;
  return type === 'EVIDENCE_REJECTED' && item.rejectionReason !== null
    ? { fileName: item.fileName, reason: item.rejectionReason }
    : { fileName: item.fileName };
};

const detailOf = (
  type: TimelineType,
  entry: HistoryRecord,
  evidence: ReadonlyArray<EvidenceDetail>,
): TimelineDetail | undefined => {
  switch (type) {
    case 'EDITED': {
      const fields = editedFields(entry.after);
      return fields.length === 0 ? undefined : { fields };
    }
    case 'EVIDENCE_ADDED':
    case 'EVIDENCE_REJECTED':
      return evidenceDetail(type, evidenceFor(entry.after, evidence));
    case 'RESOLVED_ACCEPTED':
    case 'RESOLVED_REJECTED':
    case 'WITHDRAWN':
      return entry.note === null ? undefined : { note: entry.note };
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return undefined;
    default:
      return assertNever(type);
  }
};

const toEvent = (entry: HistoryRecord, evidence: ReadonlyArray<EvidenceDetail>): TimelineEvent | null => {
  const type = timelineTypeOf(entry.action, entry.toStatus);
  if (type === null) return null;
  const detail = detailOf(type, entry, evidence);
  const base = { type, at: entry.createdAt.toISOString(), by: BY[type] };
  return detail === undefined ? base : { ...base, detail };
};

export const buildTimeline = (
  history: ReadonlyArray<HistoryRecord>,
  evidence: ReadonlyArray<EvidenceDetail>,
): ReadonlyArray<TimelineEvent> =>
  [...history]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((entry) => toEvent(entry, evidence))
    .filter((event): event is TimelineEvent => event !== null);

export type LatestHistory = {
  readonly action: HistoryAction;
  readonly toStatus: DisputeStatus;
  readonly createdAt: Date;
};

// Every dispute is written with a CREATE row; the fallback only covers rows that predate or bypass that.
export const lastEventOf = (latest: LatestHistory | null, createdAt: Date): LastEvent => {
  const type = latest === null ? null : timelineTypeOf(latest.action, latest.toStatus);
  return latest === null || type === null
    ? { type: 'SUBMITTED', at: createdAt.toISOString() }
    : { type, at: latest.createdAt.toISOString() };
};
