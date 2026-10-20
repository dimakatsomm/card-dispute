import { ERASED_TEXT } from '@cd/dispute-domain';
import { err, ok } from '@cd/shared/fp';
import type pg from 'pg';
import type { ErasureCandidate, RetentionStore } from '../use-cases/ports.ts';

export type RetentionPool = Pick<pg.Pool, 'connect' | 'query'>;

export const EXPIRE_PENDING_SQL = `
  update disputes.dispute_evidence set status = 'EXPIRED'
   where status = 'PENDING'
     and id in (select id from disputes.dispute_evidence
                 where status = 'PENDING' and created_at <= $1
                 order by created_at limit $2)`;

// The tombstone stays a literal here so the planner can match the 004 partial indexes.
export const ERASURE_CANDIDATES_SQL = `
  (select d.id, d.dispute_id, d.resolved_at as terminal_at from disputes.dispute d
    where d.status in ('RESOLVED_ACCEPTED', 'RESOLVED_REJECTED') and d.resolved_at <= $1
      and d.description <> '[erased]'
    order by d.resolved_at limit $2)
  union all
  (select d.id, d.dispute_id, h.created_at as terminal_at
     from disputes.dispute d join disputes.dispute_status_history h on h.dispute_id = d.id
    where d.status = 'WITHDRAWN' and h.action = 'WITHDRAW' and h.created_at <= $1
      and d.description <> '[erased]'
    order by h.created_at limit $2)
  order by terminal_at limit $2`;

const ERASE_DISPUTE_SQL = `
  update disputes.dispute set description = $2, resolution_note = null
   where id = $1 and status in ('RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'WITHDRAWN') and description <> $2`;

const ERASE_HISTORY_SQL = `
  update disputes.dispute_status_history set note = null, before = null, after = null
   where dispute_id = $1 and (note is not null or before is not null or after is not null)`;

// s3_key and rejection_reason are nulled by the ERASED guard trigger: the role holds no UPDATE on them.
const ERASE_EVIDENCE_SQL = `
  update disputes.dispute_evidence set status = 'ERASED', file_name = $2
   where dispute_id = $1 and (status <> 'ERASED' or file_name <> $2)`;

const sqlStateOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : 'unknown';

export const createRetentionStore = (pool: RetentionPool): RetentionStore => ({
  currentUser: async () => {
    const r = await pool.query<{ readonly user: string }>('select current_user as "user"');
    return r.rows[0]?.user ?? '';
  },

  expirePendingEvidence: async (cutoff, limit) => {
    const r = await pool.query(EXPIRE_PENDING_SQL, [cutoff, limit]);
    return r.rowCount ?? 0;
  },

  findErasureCandidates: async (cutoff, limit) => {
    const r = await pool.query<{ readonly id: string; readonly dispute_id: string }>(ERASURE_CANDIDATES_SQL, [
      cutoff,
      limit,
    ]);
    return r.rows.map((row): ErasureCandidate => ({ id: row.id, disputeId: row.dispute_id }));
  },

  eraseDispute: async (id) => {
    const client = await pool.connect();
    // Set when the connection state is unknown, so the client is destroyed instead of pooled.
    let broken = false;
    try {
      await client.query('begin');
      const dispute = await client.query(ERASE_DISPUTE_SQL, [id, ERASED_TEXT]);
      if (dispute.rowCount === 0) {
        await client.query('rollback');
        return ok('already_erased');
      }
      await client.query(ERASE_HISTORY_SQL, [id]);
      await client.query(ERASE_EVIDENCE_SQL, [id, ERASED_TEXT]);
      await client.query('commit');
      return ok('erased');
    } catch (e) {
      await client.query('rollback').catch(() => {
        broken = true;
      });
      return err({ sqlState: sqlStateOf(e) });
    } finally {
      client.release(broken);
    }
  },
});
