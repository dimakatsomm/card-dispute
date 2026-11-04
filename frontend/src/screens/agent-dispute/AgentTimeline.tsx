import { mutedClass, panelClass, sectionTitleClass } from '../../components/ui';
import { actorName, agentTimelineLabel } from '../agent-queue/labels';
import { describeRejection, formatDateTime } from '../disputes/labels';
import type { AgentTimelineEvent } from './api';

const eventDetailClass = 'mt-1 text-zinc-600 break-words';

const fieldLabel = { description: 'description', reasonCode: 'reason' } as const;

const EventDetail = ({ event }: { readonly event: AgentTimelineEvent }) => {
  const detail = event.detail;
  if (!detail) return null;
  switch (event.type) {
    case 'EDITED':
      return detail.fields && detail.fields.length > 0 ? (
        <p className={eventDetailClass}>Changed: {detail.fields.map((f) => fieldLabel[f]).join(', ')}</p>
      ) : null;
    case 'EVIDENCE_ADDED':
      return detail.fileName ? <p className={eventDetailClass}>{detail.fileName}</p> : null;
    case 'EVIDENCE_REJECTED':
      return (
        <p className={eventDetailClass}>
          {detail.fileName ? `${detail.fileName}: ` : ''}
          {describeRejection(detail.reason)}
        </p>
      );
    case 'RESOLVED_ACCEPTED':
    case 'RESOLVED_REJECTED':
    case 'WITHDRAWN':
      return detail.note ? <p className={eventDetailClass}>Note: {detail.note}</p> : null;
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return null;
  }
};

export const AgentTimeline = ({ events }: { readonly events: ReadonlyArray<AgentTimelineEvent> }) => (
  <section aria-labelledby="agent-timeline-heading" className={panelClass}>
    <h2 id="agent-timeline-heading" className={sectionTitleClass}>
      Timeline
    </h2>
    {events.length === 0 ? (
      <p className={mutedClass}>No events yet.</p>
    ) : (
      <ol aria-label="Dispute timeline" className="ml-1 space-y-5 border-l border-line pl-5">
        {events.map((event, index) => (
          <li key={`${event.at}-${event.type}-${index}`} className="relative text-sm">
            <span
              aria-hidden="true"
              className="absolute top-1 -left-[calc(1.5625rem+0.5px)] size-2.5 rounded-full bg-accent ring-4 ring-surface"
            />
            <time dateTime={event.at} className="block text-xs text-muted">
              {formatDateTime(event.at)}
            </time>{' '}
            <strong className="font-medium text-ink">{agentTimelineLabel[event.type]}</strong>{' '}
            <span className="text-muted">by {actorName(event)}</span>
            <EventDetail event={event} />
          </li>
        ))}
      </ol>
    )}
  </section>
);
