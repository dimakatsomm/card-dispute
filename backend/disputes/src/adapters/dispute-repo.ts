import { ACTOR_TYPES, DISPUTE_STATUSES, REASON_CODES } from '@cd/dispute-domain';
import { err, ok } from '@cd/shared/fp';
import type pg from 'pg';
import { z } from 'zod';
import {
  EVIDENCE_CONTENT_TYPES,
  type DisputeRecord,
  type EvidenceRecord,
  type HistoryRecord,
} from '../core/types.ts';
import type {
  DisputeChanges,
  DisputeKey,
  DisputeRepo,
  DisputeTx,
  DisputeWithHistory,
  NewDispute,
  NewHistory,
  VersionedUpdate,
} from '../use-cases/ports.ts';
import { inTransaction, type Connectable } from './db.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

const UNIQUE_VIOLATION = '23505';
export const TRANSACTION_UNIQUE = 'dispute_transaction_id_key';

const disputeRow = z
  .object({
    id: z.string(),
    dispute_id: z.string(),
    transaction_id: z.string(),
    user_id: z.string(),
    reason_code: z.enum(REASON_CODES),
    description: z.string(),
    status: z.enum(DISPUTE_STATUSES),
    version: z.number().int(),
    resolved_at: z.date().nullable(),
    resolution_note: z.string().nullable(),
    created_at: z.date(),
    updated_at: z.date(),
  })
  .transform((r): DisputeRecord => ({
    id: r.id,
    disputeId: r.dispute_id,
    transactionId: r.transaction_id,
    userId: r.user_id,
    reasonCode: r.reason_code,
    description: r.description,
    status: r.status,
    version: r.version,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

const evidenceRow = z
  .object({
    evidence_id: z.string(),
    file_name: z.string(),
    declared_content_type: z.enum(EVIDENCE_CONTENT_TYPES),
    declared_size_bytes: z.number().int(),
    declared_sha256: z.string(),
    status: z.enum(['PENDING', 'STORED', 'REJECTED', 'EXPIRED', 'ERASED']),
  })
  .transform((r): EvidenceRecord => ({
    evidenceId: r.evidence_id,
    fileName: r.file_name,
    contentType: r.declared_content_type,
    sizeBytes: r.declared_size_bytes,
    sha256: r.declared_sha256,
    status: r.status,
  }));

const historyRow = z
  .object({
    action: z.enum([
      'CREATE',
      'EDIT',
      'EVIDENCE_ADDED',
      'EVIDENCE_REJECTED',
      'REVIEW',
      'RESOLVE',
      'WITHDRAW',
    ]),
    from_status: z.enum(DISPUTE_STATUSES).nullable(),
    to_status: z.enum(DISPUTE_STATUSES),
    actor_type: z.enum(ACTOR_TYPES),
    actor_id: z.string(),
    note: z.string().nullable(),
    before: z.unknown(),
    after: z.unknown(),
    created_at: z.date(),
  })
  .transform((r): HistoryRecord => ({
    action: r.action,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    actorType: r.actor_type,
    actorId: r.actor_id,
    note: r.note,
    before: r.before ?? null,
    after: r.after ?? null,
    createdAt: r.created_at,
  }));

const DISPUTE_COLUMNS = `id::text as id, dispute_id::text as dispute_id, transaction_id::text as transaction_id,
  user_id::text as user_id, reason_code, description, status, version, resolved_at, resolution_note,
  created_at, updated_at`;

const EVIDENCE_COLUMNS = `evidence_id::text as evidence_id, file_name, declared_content_type, declared_size_bytes,
  declared_sha256, status`;

const keyPredicate = (key: DisputeKey): { readonly sql: string; readonly params: ReadonlyArray<string> } =>
  'transactionId' in key
    ? { sql: 'transaction_id = $1 and user_id = $2', params: [key.transactionId, key.userId] }
    : { sql: 'dispute_id = $1 and user_id = $2', params: [key.disputeId, key.userId] };

const firstDispute = (rows: ReadonlyArray<unknown>): DisputeRecord | null =>
  rows[0] === undefined ? null : disputeRow.parse(rows[0]);

const isTransactionUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: unknown }).code === UNIQUE_VIOLATION &&
  (e as { constraint?: unknown }).constraint === TRANSACTION_UNIQUE;

const CHANGE_COLUMNS = {
  status: 'status',
  reasonCode: 'reason_code',
  description: 'description',
  resolvedAt: 'resolved_at',
  resolutionNote: 'resolution_note',
} as const satisfies Record<keyof DisputeChanges, string>;

const setClauses = (
  changes: DisputeChanges,
): ReadonlyArray<{ readonly column: string; readonly value: unknown }> =>
  (Object.keys(CHANGE_COLUMNS) as ReadonlyArray<keyof DisputeChanges>)
    .filter((field) => changes[field] !== undefined)
    .map((field) => ({ column: CHANGE_COLUMNS[field], value: changes[field] }));

const txOps = (client: Queryable): DisputeTx => ({
  now: async () => {
    const res = await client.query<{ now: Date }>('select now() as now');
    return z.date().parse(res.rows[0]?.now);
  },

  findByTransaction: async (transactionId, userId) =>
    firstDispute(
      (
        await client.query(
          `select ${DISPUTE_COLUMNS} from dispute where transaction_id = $1 and user_id = $2`,
          [transactionId, userId],
        )
      ).rows,
    ),

  lockForUpdate: async (key) => {
    const where = keyPredicate(key);
    const res = await client.query(`select ${DISPUTE_COLUMNS} from dispute where ${where.sql} for update`, [
      ...where.params,
    ]);
    return firstDispute(res.rows);
  },

  insertDispute: async (d: NewDispute) => {
    try {
      const res = await client.query(
        `insert into dispute (transaction_id, user_id, reason_code, description, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'SUBMITTED', $5, $5) returning ${DISPUTE_COLUMNS}`,
        [d.transactionId, d.userId, d.reasonCode, d.description, d.createdBy],
      );
      return ok(disputeRow.parse(res.rows[0]));
    } catch (e) {
      if (isTransactionUniqueViolation(e)) return err('ALREADY_DISPUTED');
      throw e;
    }
  },

  insertHistory: async (h: NewHistory) => {
    await client.query(
      `insert into dispute_status_history
         (dispute_id, action, from_status, to_status, actor_type, actor_id, note, before, after)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        h.disputeRowId,
        h.action,
        h.fromStatus,
        h.toStatus,
        h.actorType,
        h.actorId,
        h.note ?? null,
        h.before === undefined ? null : JSON.stringify(h.before),
        h.after === undefined ? null : JSON.stringify(h.after),
      ],
    );
  },

  insertEvidence: async (disputeRowId, evidence) => {
    const inserted: EvidenceRecord[] = [];
    for (const e of evidence) {
      const res = await client.query(
        `insert into dispute_evidence
           (dispute_id, file_name, declared_content_type, declared_size_bytes, declared_sha256, status)
         values ($1, $2, $3, $4, $5, 'PENDING') returning ${EVIDENCE_COLUMNS}`,
        [disputeRowId, e.fileName, e.contentType, e.sizeBytes, e.sha256],
      );
      inserted.push(evidenceRow.parse(res.rows[0]));
    }
    return inserted;
  },

  updateWithVersion: async (u: VersionedUpdate) => {
    const sets = setClauses(u.changes);
    const assignments = sets.map((s, i) => `${s.column} = $${i + 4}`);
    const res = await client.query(
      `update dispute set ${[...assignments, 'version = version + 1', 'updated_by = $3'].join(', ')}
       where id = $1 and version = $2 returning ${DISPUTE_COLUMNS}`,
      [u.disputeRowId, u.expectedVersion, u.updatedBy, ...sets.map((s) => s.value)],
    );
    const updated = firstDispute(res.rows);
    return updated === null ? err('STALE_VERSION') : ok(updated);
  },
});

export const createDisputeRepo = (pool: Connectable): DisputeRepo => ({
  transact: (work) => inTransaction(pool, (client) => work(txOps(client))),

  findLatestWithHistory: async (key): Promise<DisputeWithHistory | null> => {
    const client = await pool.connect();
    try {
      const where = keyPredicate(key);
      const dispute = firstDispute(
        (await client.query(`select ${DISPUTE_COLUMNS} from dispute where ${where.sql}`, [...where.params]))
          .rows,
      );
      if (dispute === null) return null;
      const history = await client.query(
        `select action, from_status, to_status, actor_type, actor_id, note, before, after, created_at
         from dispute_status_history where dispute_id = $1 order by created_at, id`,
        [dispute.id],
      );
      const evidence = await client.query(
        `select ${EVIDENCE_COLUMNS} from dispute_evidence where dispute_id = $1 order by id`,
        [dispute.id],
      );
      return {
        dispute,
        history: history.rows.map((r) => historyRow.parse(r)),
        evidence: evidence.rows.map((r) => evidenceRow.parse(r)),
      };
    } finally {
      client.release();
    }
  },
});
