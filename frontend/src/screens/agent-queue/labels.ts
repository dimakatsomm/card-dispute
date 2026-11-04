import type { components } from '../../api/generated/disputes';
import type { DisputeStatus, TimelineType } from '../disputes/labels';

type Schemas = components['schemas'];
export type QueueStatus = Schemas['QueueItem']['status'];
export type AgentActor = Schemas['AgentTimelineEvent']['by'];

export const QUEUE_STATUSES: ReadonlyArray<QueueStatus> = ['SUBMITTED', 'UNDER_REVIEW'];

export const isQueueStatus = (value: string | null): value is QueueStatus =>
  QUEUE_STATUSES.some((status) => status === value);

export const agentStatusLabel: Readonly<Record<DisputeStatus, string>> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  RESOLVED_ACCEPTED: 'Resolved: accepted',
  RESOLVED_REJECTED: 'Resolved: rejected',
  WITHDRAWN: 'Withdrawn',
};

export const agentTimelineLabel: Readonly<Record<TimelineType, string>> = {
  SUBMITTED: 'Dispute submitted',
  EDITED: 'Dispute edited',
  EVIDENCE_ADDED: 'Evidence added',
  EVIDENCE_REJECTED: 'Evidence rejected',
  UNDER_REVIEW: 'Picked up for review',
  RESOLVED_ACCEPTED: 'Resolved: accepted',
  RESOLVED_REJECTED: 'Resolved: rejected',
  WITHDRAWN: 'Withdrawn by the customer',
};

export const actorName = (event: { readonly by: AgentActor; readonly agentName?: string }): string => {
  switch (event.by) {
    case 'CUSTOMER':
      return 'the customer';
    case 'SYSTEM':
      return 'the system';
    case 'AGENT':
      return event.agentName ?? 'an agent';
  }
};
