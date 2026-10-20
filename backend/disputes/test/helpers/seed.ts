import type { TestDb } from './db.ts';

type Status = 'SUBMITTED' | 'UNDER_REVIEW' | 'RESOLVED_ACCEPTED' | 'RESOLVED_REJECTED' | 'WITHDRAWN';

export type SeededDispute = { readonly rowId: string; readonly disputeId: string };

export const DESCRIPTION = 'I did not make this purchase; my card was with me.';

// Inserted as disputes_app, so the CHECKs, grants and the created_at/updated_at the API pages on are real.
export const seedDispute = async (
  db: TestDb,
  d: {
    readonly userId: string;
    readonly transactionId: string;
    readonly status?: Status;
    readonly version?: number;
    readonly updatedAt?: string;
    readonly createdAt?: string;
    readonly resolutionNote?: string | null;
  },
): Promise<SeededDispute> => {
  const status = d.status ?? 'SUBMITTED';
  const createdAt = d.createdAt ?? '2026-10-01T08:00:00.000000Z';
  const res = await db.appQuery(
    `insert into dispute (transaction_id, user_id, reason_code, description, status, version, resolved_at,
       resolution_note, created_by, updated_by, created_at, updated_at)
     values ($1, $2, 'FRAUD', $3, $4, $5, $6, $7, $8, $8, $9::timestamptz, $10::timestamptz)
     returning id::text as id, dispute_id::text as dispute_id`,
    [
      d.transactionId,
      d.userId,
      DESCRIPTION,
      status,
      d.version ?? 1,
      status.startsWith('RESOLVED_') ? (d.updatedAt ?? createdAt) : null,
      d.resolutionNote ?? null,
      `USER:${d.userId}`,
      createdAt,
      d.updatedAt ?? createdAt,
    ],
  );
  const row = res.rows[0] as { id: string; dispute_id: string };
  return { rowId: row.id, disputeId: row.dispute_id };
};

export const seedHistory = async (
  db: TestDb,
  rowId: string,
  h: {
    readonly action:
      'CREATE' | 'EDIT' | 'EVIDENCE_ADDED' | 'EVIDENCE_REJECTED' | 'REVIEW' | 'RESOLVE' | 'WITHDRAW';
    readonly fromStatus: Status | null;
    readonly toStatus: Status;
    readonly actorType: 'USER' | 'SYSTEM_RULE' | 'AGENT';
    readonly actorId: string;
    readonly createdAt: string;
    readonly note?: string;
    readonly before?: unknown;
    readonly after?: unknown;
  },
): Promise<void> => {
  await db.appQuery(
    `insert into dispute_status_history
       (dispute_id, action, from_status, to_status, actor_type, actor_id, note, before, after, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
    [
      rowId,
      h.action,
      h.fromStatus,
      h.toStatus,
      h.actorType,
      h.actorId,
      h.note ?? null,
      h.before === undefined ? null : JSON.stringify(h.before),
      h.after === undefined ? null : JSON.stringify(h.after),
      h.createdAt,
    ],
  );
};

export const seedEvidence = async (
  db: TestDb,
  seeded: SeededDispute,
  e: {
    readonly fileName: string;
    readonly status: 'PENDING' | 'STORED' | 'REJECTED' | 'EXPIRED' | 'ERASED';
    readonly rejectionReason?: 'MALWARE' | 'TYPE_MISMATCH' | 'CHECKSUM' | 'SIZE';
    readonly contentType?: 'application/pdf' | 'image/jpeg' | 'image/png';
    readonly sizeBytes?: number;
    readonly sha256?: string;
  },
): Promise<string> => {
  const reason = e.status === 'REJECTED' ? (e.rejectionReason ?? 'MALWARE') : null;
  const res = await db.appQuery(
    `insert into dispute_evidence
       (dispute_id, file_name, declared_content_type, declared_size_bytes, declared_sha256, status, rejection_reason)
     values ($1, $2, $5, $6, $7, $3, $4)
     returning evidence_id::text as evidence_id`,
    [
      seeded.rowId,
      e.fileName,
      e.status === 'STORED' ? 'PENDING' : e.status,
      reason,
      e.contentType ?? 'application/pdf',
      e.sizeBytes ?? 1024,
      e.sha256 ?? 'a'.repeat(64),
    ],
  );
  const evidenceId = (res.rows[0] as { evidence_id: string }).evidence_id;
  // STORED needs an s3_key derived from the generated evidence_id, so it is promoted the way evidence-intake does.
  if (e.status === 'STORED') {
    await db.appQuery(
      "update dispute_evidence set status = 'STORED', s3_key = $2, stored_at = now() where evidence_id = $1",
      [evidenceId, `evidence/${seeded.disputeId}/${evidenceId}`],
    );
  }
  return evidenceId;
};
