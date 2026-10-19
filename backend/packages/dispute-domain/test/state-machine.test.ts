import { err, ok } from '@cd/shared/fp';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  DISPUTE_STATUSES,
  applyAction,
  type ActorType,
  type Dispute,
  type DisputeAction,
  type DisputeStatus,
} from '../src/index.ts';

const ACTIONS = {
  EDIT: { type: 'EDIT', changes: { description: 'Updated description text' } },
  WITHDRAW: { type: 'WITHDRAW' },
  REVIEW: { type: 'REVIEW' },
  RESOLVE_ACCEPTED: { type: 'RESOLVE', outcome: 'ACCEPTED' },
  RESOLVE_REJECTED: { type: 'RESOLVE', outcome: 'REJECTED' },
} as const satisfies Record<string, DisputeAction>;
type ActionName = keyof typeof ACTIONS;

type Outcome = { kind: 'APPLIED'; to: DisputeStatus } | { kind: 'NO_OP' };

// Written out from docs/04 independently of TRANSITION_TABLE; every cell not listed is INVALID_TRANSITION.
const ALLOWED: Readonly<Record<string, Outcome>> = {
  'SUBMITTED|EDIT|USER': { kind: 'APPLIED', to: 'SUBMITTED' },
  'SUBMITTED|WITHDRAW|USER': { kind: 'APPLIED', to: 'WITHDRAWN' },
  'UNDER_REVIEW|WITHDRAW|USER': { kind: 'APPLIED', to: 'WITHDRAWN' },
  'SUBMITTED|REVIEW|AGENT': { kind: 'APPLIED', to: 'UNDER_REVIEW' },
  'SUBMITTED|RESOLVE_ACCEPTED|AGENT': { kind: 'APPLIED', to: 'RESOLVED_ACCEPTED' },
  'SUBMITTED|RESOLVE_REJECTED|AGENT': { kind: 'APPLIED', to: 'RESOLVED_REJECTED' },
  'UNDER_REVIEW|RESOLVE_ACCEPTED|AGENT': { kind: 'APPLIED', to: 'RESOLVED_ACCEPTED' },
  'UNDER_REVIEW|RESOLVE_REJECTED|AGENT': { kind: 'APPLIED', to: 'RESOLVED_REJECTED' },
  'UNDER_REVIEW|REVIEW|AGENT': { kind: 'NO_OP' },
  'RESOLVED_ACCEPTED|RESOLVE_ACCEPTED|AGENT': { kind: 'NO_OP' },
  'RESOLVED_REJECTED|RESOLVE_REJECTED|AGENT': { kind: 'NO_OP' },
};

const disputeIn = (status: DisputeStatus): Dispute =>
  Object.freeze({ status, version: 3, reasonCode: 'FRAUD', description: 'Original description' });

const actorOf = (type: ActorType) => Object.freeze({ type, id: `${type}-1` });

describe('applyAction', () => {
  const cells = DISPUTE_STATUSES.flatMap((status) =>
    (Object.keys(ACTIONS) as ReadonlyArray<ActionName>).flatMap((action) =>
      ACTOR_TYPES.map((actor) => ({ status, action, actor, outcome: ALLOWED[`${status}|${action}|${actor}`] })),
    ),
  );

  it.each(cells)('$status × $action × $actor', ({ status, action, actor, outcome }) => {
    const dispute = disputeIn(status);
    const result = applyAction(dispute, ACTIONS[action], actorOf(actor));

    if (outcome === undefined) {
      expect(result).toEqual(err('INVALID_TRANSITION'));
    } else if (outcome.kind === 'NO_OP') {
      expect(result).toEqual(ok({ kind: 'NO_OP', dispute }));
    } else {
      const description = action === 'EDIT' ? 'Updated description text' : dispute.description;
      expect(result).toEqual(
        ok({ kind: 'APPLIED', from: status, to: outcome.to, dispute: { ...dispute, description, status: outcome.to, version: 4 } }),
      );
    }
  });

  const user = actorOf('USER');
  const submitted = disputeIn('SUBMITTED');
  const editRows: ReadonlyArray<{ name: string; changes: { reasonCode?: string; description?: string }; expected: ReturnType<typeof applyAction<Dispute>> }> = [
    {
      name: 'EDIT changes reasonCode and keeps description',
      changes: { reasonCode: 'DUPLICATE' },
      expected: ok({ kind: 'APPLIED', from: 'SUBMITTED', to: 'SUBMITTED', dispute: { ...submitted, reasonCode: 'DUPLICATE', version: 4 } }),
    },
    {
      name: 'EDIT leaving every field unchanged is a no-op without a version bump',
      changes: { reasonCode: 'FRAUD', description: 'Original description' },
      expected: ok({ kind: 'NO_OP', dispute: submitted }),
    },
    { name: 'EDIT with unknown reason is rejected', changes: { reasonCode: 'NOPE' }, expected: err('INVALID_REASON') },
    { name: 'EDIT with short description is rejected', changes: { description: 'too short' }, expected: err('INVALID_DESCRIPTION') },
  ];

  it.each(editRows)('$name', ({ changes, expected }) => {
    expect(applyAction(submitted, { type: 'EDIT', changes }, user)).toEqual(expected);
  });
});
