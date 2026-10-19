import { err, ok, type Result } from '@cd/shared/fp';
import { validateDisputeInput, type InputError } from './dispute-input.ts';
import type { ReasonCode } from './reason-codes.ts';

export const DISPUTE_STATUSES = Object.freeze([
  'SUBMITTED',
  'UNDER_REVIEW',
  'RESOLVED_ACCEPTED',
  'RESOLVED_REJECTED',
  'WITHDRAWN',
] as const);
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const TERMINAL_STATUSES = Object.freeze([
  'RESOLVED_ACCEPTED',
  'RESOLVED_REJECTED',
  'WITHDRAWN',
] as const satisfies ReadonlyArray<DisputeStatus>);

export const isTerminal = (status: DisputeStatus): boolean =>
  (TERMINAL_STATUSES as ReadonlyArray<DisputeStatus>).includes(status);

export const ACTOR_TYPES = Object.freeze(['USER', 'SYSTEM_RULE', 'AGENT'] as const);
export type ActorType = (typeof ACTOR_TYPES)[number];

export type Actor = {
  readonly type: ActorType;
  readonly id: string;
};

export const ACTION_TYPES = Object.freeze(['EDIT', 'WITHDRAW', 'REVIEW', 'RESOLVE'] as const);
export type ActionType = (typeof ACTION_TYPES)[number];

export type ResolutionOutcome = 'ACCEPTED' | 'REJECTED';

export type DisputeAction =
  | { readonly type: 'EDIT'; readonly changes: { readonly reasonCode?: string; readonly description?: string } }
  | { readonly type: 'WITHDRAW' }
  | { readonly type: 'REVIEW' }
  | { readonly type: 'RESOLVE'; readonly outcome: ResolutionOutcome };

export type Dispute = {
  readonly status: DisputeStatus;
  readonly version: number;
  readonly reasonCode: ReasonCode;
  readonly description: string;
};

export type TransitionRow = {
  readonly action: ActionType;
  readonly outcome?: ResolutionOutcome;
  readonly actor: ActorType;
  readonly from: ReadonlyArray<DisputeStatus>;
  readonly to: DisputeStatus;
  readonly replayIsNoOp: boolean;
};

const frozenRow = (row: TransitionRow): TransitionRow => Object.freeze({ ...row, from: Object.freeze([...row.from]) });

// Anything not listed here, including every SYSTEM_RULE action (ADR-033), is INVALID_TRANSITION.
export const TRANSITION_TABLE: ReadonlyArray<TransitionRow> = Object.freeze([
  frozenRow({ action: 'EDIT', actor: 'USER', from: ['SUBMITTED'], to: 'SUBMITTED', replayIsNoOp: false }),
  frozenRow({ action: 'WITHDRAW', actor: 'USER', from: ['SUBMITTED', 'UNDER_REVIEW'], to: 'WITHDRAWN', replayIsNoOp: false }),
  frozenRow({ action: 'REVIEW', actor: 'AGENT', from: ['SUBMITTED'], to: 'UNDER_REVIEW', replayIsNoOp: true }),
  frozenRow({
    action: 'RESOLVE',
    outcome: 'ACCEPTED',
    actor: 'AGENT',
    from: ['SUBMITTED', 'UNDER_REVIEW'],
    to: 'RESOLVED_ACCEPTED',
    replayIsNoOp: true,
  }),
  frozenRow({
    action: 'RESOLVE',
    outcome: 'REJECTED',
    actor: 'AGENT',
    from: ['SUBMITTED', 'UNDER_REVIEW'],
    to: 'RESOLVED_REJECTED',
    replayIsNoOp: true,
  }),
]);

export type TransitionError = 'INVALID_TRANSITION' | InputError;

export type Transition<D extends Dispute> =
  | { readonly kind: 'APPLIED'; readonly dispute: D; readonly from: DisputeStatus; readonly to: DisputeStatus }
  | { readonly kind: 'NO_OP'; readonly dispute: D };

const outcomeOf = (action: DisputeAction): ResolutionOutcome | undefined =>
  action.type === 'RESOLVE' ? action.outcome : undefined;

const findRow = (action: DisputeAction, actor: Actor): TransitionRow | undefined =>
  TRANSITION_TABLE.find(
    (row) => row.action === action.type && row.outcome === outcomeOf(action) && row.actor === actor.type,
  );

const withEdits = <D extends Dispute>(dispute: D, action: DisputeAction): Result<D, InputError> => {
  if (action.type !== 'EDIT') return ok(dispute);
  const valid = validateDisputeInput({
    reasonCode: action.changes.reasonCode ?? dispute.reasonCode,
    description: action.changes.description ?? dispute.description,
  });
  return valid.ok ? ok({ ...dispute, ...valid.value }) : valid;
};

const isUnchanged = (before: Dispute, after: Dispute): boolean =>
  before.reasonCode === after.reasonCode && before.description === after.description;

export const applyAction = <D extends Dispute>(
  dispute: D,
  action: DisputeAction,
  actor: Actor,
): Result<Transition<D>, TransitionError> => {
  const row = findRow(action, actor);
  if (row === undefined) return err('INVALID_TRANSITION');

  if (!row.from.includes(dispute.status)) {
    return row.replayIsNoOp && dispute.status === row.to ? ok({ kind: 'NO_OP', dispute }) : err('INVALID_TRANSITION');
  }

  const edited = withEdits(dispute, action);
  if (!edited.ok) return edited;
  if (action.type === 'EDIT' && isUnchanged(dispute, edited.value)) return ok({ kind: 'NO_OP', dispute });

  return ok({
    kind: 'APPLIED',
    dispute: { ...edited.value, status: row.to, version: dispute.version + 1 },
    from: dispute.status,
    to: row.to,
  });
};
