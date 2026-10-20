import {
  actorLabel,
  describeRejection,
  formatDateTime,
  timelineLabel,
} from '../disputes/labels';
import type { TimelineEvent } from './api';

const fieldLabel = { description: 'description', reasonCode: 'reason' } as const;

const EventDetail = ({ event }: { readonly event: TimelineEvent }) => {
  const detail = event.detail;
  if (!detail) return null;
  switch (event.type) {
    case 'EDITED':
      return detail.fields && detail.fields.length > 0 ? (
        <p>Changed: {detail.fields.map((f) => fieldLabel[f]).join(', ')}</p>
      ) : null;
    case 'EVIDENCE_ADDED':
      return detail.fileName ? <p>{detail.fileName}</p> : null;
    case 'EVIDENCE_REJECTED':
      return (
        <p>
          {detail.fileName ? `${detail.fileName}: ` : ''}
          {describeRejection(detail.reason)}
        </p>
      );
    case 'RESOLVED_ACCEPTED':
    case 'RESOLVED_REJECTED':
    case 'WITHDRAWN':
      return detail.note ? <p>Note: {detail.note}</p> : null;
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return null;
  }
};

// Renders only the contract's CUSTOMER/BANK attribution so no agent identity can leak even if extra fields arrive.
export const Timeline = ({ events }: { readonly events: ReadonlyArray<TimelineEvent> }) => (
  <section aria-labelledby="timeline-heading">
    <h2 id="timeline-heading">Timeline</h2>
    {events.length === 0 ? (
      <p>No events yet.</p>
    ) : (
      <ol aria-label="Dispute timeline">
        {events.map((event, index) => (
          <li key={`${event.at}-${event.type}-${index}`}>
            <time dateTime={event.at}>{formatDateTime(event.at)}</time>{' '}
            <strong>{timelineLabel[event.type]}</strong> <span>by {actorLabel[event.by]}</span>
            <EventDetail event={event} />
          </li>
        ))}
      </ol>
    )}
  </section>
);
