import {
  actorLabel,
  describeRejection,
  formatDateTime,
  timelineLabel,
} from '../disputes/labels';
import { mutedClass, panelClass, sectionTitleClass } from '../../components/ui';
import type { TimelineEvent } from './api';
import { visibleText } from './core';

const eventDetailClass = 'mt-1 text-zinc-600 break-words';

const fieldLabel = { description: 'description', reasonCode: 'reason' } as const;

const EventDetail = ({ event }: { readonly event: TimelineEvent }) => {
  const detail = event.detail;
  if (!detail) return null;
  const fileName = visibleText(detail.fileName);
  const note = visibleText(detail.note);
  switch (event.type) {
    case 'EDITED':
      return detail.fields && detail.fields.length > 0 ? (
        <p className={eventDetailClass}>Changed: {detail.fields.map((f) => fieldLabel[f]).join(', ')}</p>
      ) : null;
    case 'EVIDENCE_ADDED':
      return fileName ? <p className={eventDetailClass}>{fileName}</p> : null;
    case 'EVIDENCE_REJECTED':
      return (
        <p className={eventDetailClass}>
          {fileName ? `${fileName}: ` : ''}
          {describeRejection(detail.reason)}
        </p>
      );
    case 'RESOLVED_ACCEPTED':
    case 'RESOLVED_REJECTED':
    case 'WITHDRAWN':
      return note ? <p className={eventDetailClass}>Note: {note}</p> : null;
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return null;
  }
};

// Renders only the contract's CUSTOMER/BANK attribution so no agent identity can leak even if extra fields arrive.
export const Timeline = ({ events }: { readonly events: ReadonlyArray<TimelineEvent> }) => (
  <section aria-labelledby="timeline-heading" className={panelClass}>
    <h2 id="timeline-heading" className={sectionTitleClass}>
      Timeline
    </h2>
    {events.length === 0 ? (
      <p className={mutedClass}>No events yet.</p>
    ) : (
      <ol aria-label="Dispute timeline" className="ml-1 space-y-5 border-l border-line pl-5">
        {events.map((event, index) => (
          <li key={`${event.at}-${event.type}-${index}`} className="relative text-sm">
            {/* Centres the dot on the list's border: pl-5 (1.25rem) + half the dot (0.3125rem) + half the 1px border. */}
            <span
              aria-hidden="true"
              className="absolute top-1 -left-[calc(1.5625rem+0.5px)] size-2.5 rounded-full bg-accent ring-4 ring-surface"
            />
            <time dateTime={event.at} className="block text-xs text-muted">
              {formatDateTime(event.at)}
            </time>{' '}
            <strong className="font-medium text-ink">{timelineLabel[event.type]}</strong>{' '}
            <span className="text-muted">by {actorLabel[event.by]}</span>
            <EventDetail event={event} />
          </li>
        ))}
      </ol>
    )}
  </section>
);
