import {
  ACTOR_TYPES,
  DISPUTE_STATUSES,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_REJECTION_REASONS,
  EVIDENCE_STATUSES,
  REASON_CODES,
} from '@cd/dispute-domain';
import { err, ok } from '@cd/shared/fp';
import type pg from 'pg';
import { z } from 'zod';
import type { QueueRecord } from '../core/agent-view.ts';
import type { RecentViews } from '../core/evidence-view.ts';
import type { DisputeRecord, EvidenceRecord, HistoryRecord } from '../core/types.ts';
import type { EvidenceDetail } from '../core/timeline.ts';
import type {
  DisputeChanges,
  DisputeKey,
  DisputePageQuery,
  DisputeRepo,
  DisputeSummaryRecord,
  DisputeTx,
  DisputeWithHistory,
  EvidenceForAgent,
  EvidenceSettlement,
  NewDispute,
  NewEvidenceView,
  NewHistory,
  ReviewQueueQuery,
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
    status: z.enum(EVIDENCE_STATUSES),
  })
  .transform((r): EvidenceRecord => ({
    evidenceId: r.evidence_id,
    fileName: r.file_name,
    contentType: r.declared_content_type,
    sizeBytes: r.declared_size_bytes,
    sha256: r.declared_sha256,
    status: r.status,
  }));

const evidenceDetailRow = z
  .object({ rejection_reason: z.enum(EVIDENCE_REJECTION_REASONS).nullable() })
  .loose()
  .transform((r): EvidenceDetail => ({ ...evidenceRow.parse(r), rejectionReason: r.rejection_reason }));

const historyAction = z.enum([
  'CREATE',
  'EDIT',
  'EVIDENCE_ADDED',
  'EVIDENCE_REJECTED',
  'REVIEW',
  'RESOLVE',
  'WITHDRAW',
]);

const historyRow = z
  .object({
    action: historyAction,
    from_status: z.enum(DISPUTE_STATUSES).nullable(),
    to_status: z.enum(DISPUTE_STATUSES),
    actor_type: z.enum(ACTOR_TYPES),
    actor_id: z.string(),
    actor_label: z.string().nullable(),
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
    actorLabel: r.actor_label,
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

const summaryRow = z
  .object({
    cursor_at: z.string(),
    last_action: historyAction.nullable(),
    last_to_status: z.enum(DISPUTE_STATUSES).nullable(),
    last_at: z.date().nullable(),
  })
  .loose()
  .transform((r): DisputeSummaryRecord => {
    const dispute = disputeRow.parse(r);
    return {
      dispute,
      latest:
        r.last_action === null || r.last_to_status === null || r.last_at === null
          ? null
          : { action: r.last_action, toStatus: r.last_to_status, createdAt: r.last_at },
      position: { updatedAt: r.cursor_at, disputeId: dispute.disputeId },
    };
  });

const refRow = z.object({
  transaction_id: z.string(),
  dispute_id: z.string(),
  status: z.enum(DISPUTE_STATUSES),
  version: z.number().int(),
});

// Microsecond text, because a millisecond Date would skip or repeat rows that tie within the same millisecond.
const CURSOR_AT = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at`;

const queueRow = z
  .object({
    row_id: z.string(),
    dispute_id: z.string(),
    transaction_id: z.string(),
    status: z.enum(['SUBMITTED', 'UNDER_REVIEW']),
    reason_code: z.enum(REASON_CODES),
    version: z.number().int(),
    created_at: z.date(),
    cursor_at: z.string(),
    reviewer_name: z.string().nullable(),
  })
  .transform(
    (r): QueueRecord => ({
      disputeId: r.dispute_id,
      transactionId: r.transaction_id,
      status: r.status,
      reasonCode: r.reason_code,
      version: r.version,
      createdAt: r.created_at,
      reviewerName: r.reviewer_name,
      position: { createdAt: r.cursor_at, rowId: r.row_id },
    }),
  );

// The literal IN mirrors the partial index predicate, so the planner can prove the index applies (migration 005).
export const reviewQueueSql = (keyset: boolean): string =>
  `select d.id::text as row_id, d.dispute_id::text as dispute_id, d.transaction_id::text as transaction_id,
     d.status, d.reason_code, d.version, d.created_at,
     to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at, r.reviewer_name
   from dispute d
   left join lateral (
     select actor_label as reviewer_name from dispute_status_history
     where dispute_id = d.id and action = 'REVIEW' and actor_type = 'AGENT'
     order by created_at desc, id desc limit 1
   ) r on true
   where d.status in ('SUBMITTED', 'UNDER_REVIEW') and d.status = any($1::text[])
     ${keyset ? 'and (d.created_at, d.id) > ($3::timestamptz, $4::bigint)' : ''}
   order by d.created_at, d.id
   limit $2`;

export const reviewQueueParams = (q: ReviewQueueQuery): ReadonlyArray<unknown> =>
  q.after === null ? [q.statuses, q.limit] : [q.statuses, q.limit, q.after.createdAt, q.after.rowId];

type Filter = { readonly where: ReadonlyArray<string>; readonly params: ReadonlyArray<unknown> };

const addFilter = (
  filter: Filter,
  sql: (...placeholders: ReadonlyArray<string>) => string,
  ...values: ReadonlyArray<unknown>
): Filter => ({
  where: [...filter.where, sql(...values.map((_, i) => `$${filter.params.length + i + 1}`))],
  params: [...filter.params, ...values],
});

const pageFilter = (q: DisputePageQuery): Filter => {
  const owned = addFilter({ where: [], params: [] }, (p) => `user_id = ${p}::uuid`, q.userId);
  const byStatus =
    q.statuses.length === 0 ? owned : addFilter(owned, (p) => `status = any(${p}::text[])`, q.statuses);
  const byTxn =
    q.transactionIds === null
      ? byStatus
      : addFilter(byStatus, (p) => `transaction_id = any(${p}::uuid[])`, q.transactionIds);
  return q.after === null
    ? byTxn
    : addFilter(
        byTxn,
        (at, id) => `(updated_at, dispute_id) < (${at}::timestamptz, ${id}::uuid)`,
        q.after.updatedAt,
        q.after.disputeId,
      );
};

const recentViewsRow = z
  .object({ n: z.number().int(), seconds_left: z.number().nullable() })
  .transform((r): RecentViews => ({ count: r.n, secondsUntilOldestLeaves: r.seconds_left }));

const evidenceForAgentRow = z
  .object({
    dispute_row_id: z.string(),
    dispute_id: z.string(),
    evidence_row_id: z.string(),
    declared_content_type: z.enum(EVIDENCE_CONTENT_TYPES),
    status: z.enum(EVIDENCE_STATUSES),
  })
  .transform((r): EvidenceForAgent => ({
    disputeRowId: r.dispute_row_id,
    disputeId: r.dispute_id,
    evidenceRowId: r.evidence_row_id,
    contentType: r.declared_content_type,
    status: r.status,
  }));

type Predicate = { readonly sql: string; readonly params: ReadonlyArray<string> };

const keyPredicate = (key: DisputeKey): Predicate =>
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

  lockForAgent: async (transactionId) =>
    firstDispute(
      (await client.query(`select ${DISPUTE_COLUMNS} from dispute where transaction_id = $1 for update`, [transactionId]))
        .rows,
    ),

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
         (dispute_id, action, from_status, to_status, actor_type, actor_id, actor_label, note, before, after)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        h.disputeRowId,
        h.action,
        h.fromStatus,
        h.toStatus,
        h.actorType,
        h.actorId,
        h.actorLabel ?? null,
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

  listEvidence: async (disputeRowId) => {
    const res = await client.query(
      `select ${EVIDENCE_COLUMNS} from dispute_evidence where dispute_id = $1 order by id`,
      [disputeRowId],
    );
    return res.rows.map((r) => evidenceRow.parse(r));
  },

  // FOR SHARE keeps the status stable for the history row without touching version or updated_at.
  lockForShareByTransaction: async (transactionId) =>
    firstDispute(
      (
        await client.query(`select ${DISPUTE_COLUMNS} from dispute where transaction_id = $1 for share`, [
          transactionId,
        ])
      ).rows,
    ),

  lockEvidence: async (disputeRowId, evidenceId) => {
    const res = await client.query(
      `select ${EVIDENCE_COLUMNS}, rejection_reason from dispute_evidence
       where dispute_id = $1 and evidence_id = $2 for update`,
      [disputeRowId, evidenceId],
    );
    return res.rows[0] === undefined ? null : evidenceDetailRow.parse(res.rows[0]);
  },

  settleEvidence: async (s: EvidenceSettlement) => {
    const res = await client.query(
      `update dispute_evidence
       set status = $3::text, s3_key = $4, rejection_reason = $5,
           stored_at = case when $3::text = 'STORED' then now() end
       where dispute_id = $1 and evidence_id = $2 and status = 'PENDING'
       returning updated_at`,
      [
        s.disputeRowId,
        s.evidenceId,
        s.outcome.status,
        s.s3Key,
        s.outcome.status === 'REJECTED' ? s.outcome.reason : null,
      ],
    );
    return res.rows[0] === undefined
      ? null
      : z.object({ updated_at: z.date() }).parse(res.rows[0]).updated_at;
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

  // Two-key form, so it never collides with the single-key migration lock; serialises one agent's count and insert.
  lockAgentViews: async (agentId) => {
    await client.query("select pg_advisory_xact_lock(hashtext('evidence_view'), hashtext($1::text))", [
      agentId,
    ]);
  },

  // DB clock on both sides: viewed_at defaults to now(), so the window is measured on the same clock.
  recentViews: async (agentId, windowMinutes) => {
    const res = await client.query(
      `select count(*)::int as n,
         extract(epoch from min(viewed_at) + make_interval(mins => $2) - now())::float8 as seconds_left
       from evidence_view where agent_id = $1 and viewed_at > now() - make_interval(mins => $2)`,
      [agentId, windowMinutes],
    );
    return recentViewsRow.parse(res.rows[0]);
  },

  insertEvidenceView: async (v: NewEvidenceView) => {
    await client.query('insert into evidence_view (evidence_id, dispute_id, agent_id) values ($1, $2, $3)', [
      v.evidenceRowId,
      v.disputeRowId,
      v.agentId,
    ]);
  },
});

const readWithHistory = async (client: Queryable, where: Predicate): Promise<DisputeWithHistory | null> => {
  const dispute = firstDispute(
    (await client.query(`select ${DISPUTE_COLUMNS} from dispute where ${where.sql}`, [...where.params])).rows,
  );
  if (dispute === null) return null;
  const history = await client.query(
    `select action, from_status, to_status, actor_type, actor_id, actor_label, note, before, after, created_at
     from dispute_status_history where dispute_id = $1 order by created_at, id`,
    [dispute.id],
  );
  const evidence = await client.query(
    `select ${EVIDENCE_COLUMNS}, rejection_reason from dispute_evidence where dispute_id = $1 order by id`,
    [dispute.id],
  );
  return {
    dispute,
    history: history.rows.map((r) => historyRow.parse(r)),
    evidence: evidence.rows.map((r) => evidenceDetailRow.parse(r)),
  };
};

// One snapshot, so the version, digest and timeline can never come from different commits.
const readSnapshot = async (pool: Connectable, where: Predicate): Promise<DisputeWithHistory | null> => {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('begin isolation level repeatable read read only');
    const found = await readWithHistory(client, where);
    await client.query('commit');
    return found;
  } catch (e) {
    await client.query('rollback').catch(() => {
      broken = true;
    });
    throw e;
  } finally {
    client.release(broken);
  }
};

export const createDisputeRepo = (pool: Connectable & Pick<pg.Pool, 'query'>): DisputeRepo => ({
  transact: (work) => inTransaction(pool, (client) => work(txOps(client))),

  findLatestWithHistory: (key) => readSnapshot(pool, keyPredicate(key)),

  // Unscoped by owner on purpose: only the agent routes call this (ADR-071).
  findForAgent: (transactionId) => readSnapshot(pool, { sql: 'transaction_id = $1', params: [transactionId] }),

  findEvidenceForAgent: async (transactionId, evidenceId) => {
    const res = await pool.query(
      `select d.id::text as dispute_row_id, d.dispute_id::text as dispute_id, e.id::text as evidence_row_id,
         e.declared_content_type, e.status
       from dispute d join dispute_evidence e on e.dispute_id = d.id
       where d.transaction_id = $1 and e.evidence_id = $2`,
      [transactionId, evidenceId],
    );
    return res.rows[0] === undefined ? null : evidenceForAgentRow.parse(res.rows[0]);
  },

  // Unnamed on purpose: a named statement may switch to a generic plan, which cannot use the partial index.
  listReviewQueue: async (query) => {
    const res = await pool.query(reviewQueueSql(query.after !== null), [...reviewQueueParams(query)]);
    return res.rows.map((r) => queueRow.parse(r));
  },

  listTransactionIds: async (userId, statuses) => {
    const res = await pool.query(
      statuses.length === 0
        ? 'select transaction_id::text as transaction_id from dispute where user_id = $1'
        : 'select transaction_id::text as transaction_id from dispute where user_id = $1 and status = any($2::text[])',
      statuses.length === 0 ? [userId] : [userId, statuses],
    );
    return res.rows.map((r) => z.object({ transaction_id: z.string() }).parse(r).transaction_id);
  },

  listPage: async (query) => {
    const filter = pageFilter(query);
    const res = await pool.query(
      `select ${DISPUTE_COLUMNS}, ${CURSOR_AT}, h.last_action, h.last_to_status, h.last_at
       from dispute d
       left join lateral (
         select action as last_action, to_status as last_to_status, created_at as last_at
         from dispute_status_history where dispute_id = d.id order by created_at desc, id desc limit 1
       ) h on true
       where ${filter.where.join(' and ')}
       order by updated_at desc, dispute_id desc
       limit $${filter.params.length + 1}`,
      [...filter.params, query.limit],
    );
    return res.rows.map((r) => summaryRow.parse(r));
  },

  lookupRefs: async (userId, transactionIds) => {
    const res = await pool.query(
      `select transaction_id::text as transaction_id, dispute_id::text as dispute_id, status, version
       from dispute where user_id = $1 and transaction_id = any($2::uuid[])`,
      [userId, transactionIds],
    );
    return res.rows.map((r) => {
      const row = refRow.parse(r);
      return {
        transactionId: row.transaction_id,
        disputeId: row.dispute_id,
        status: row.status,
        version: row.version,
      };
    });
  },
});
