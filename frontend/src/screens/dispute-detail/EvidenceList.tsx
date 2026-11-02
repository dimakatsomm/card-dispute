import { Link } from 'react-router';
import { Badge, cx, evidenceStatusTone, linkClass, listClass, mutedClass } from '../../components/ui';
import { describeRejection, evidenceStatusLabel } from '../disputes/labels';
import type { Evidence } from './api';

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const itemClass = 'px-4 py-3 text-sm leading-relaxed';

const EvidenceItem = ({ item, addEvidencePath }: { readonly item: Evidence; readonly addEvidencePath: string | null }) => {
  if (item.status === 'ERASED') return <li className={cx(itemClass, 'text-muted')}>File removed under our retention policy.</li>;
  return (
    <li className={itemClass}>
      <span className="font-medium break-all text-ink">{item.fileName}</span>{' '}
      <span className="text-muted tabular-nums">({formatSize(item.sizeBytes)})</span>{' '}
      <Badge tone={evidenceStatusTone[item.status]} className="align-middle">
        {evidenceStatusLabel[item.status]}
      </Badge>
      {item.status === 'REJECTED' ? (
        <span className="text-danger-strong">: {describeRejection(item.rejectionReason)}</span>
      ) : null}
      {item.status === 'EXPIRED' && addEvidencePath ? (
        <>
          {' '}
          <span className="text-zinc-600">
            You can{' '}
            <Link to={addEvidencePath} className={linkClass}>
              upload it again
            </Link>
            .
          </span>
        </>
      ) : null}
    </li>
  );
};

export const EvidenceList = ({
  evidence,
  addEvidencePath,
}: {
  readonly evidence: ReadonlyArray<Evidence>;
  readonly addEvidencePath: string | null;
}) =>
  evidence.length === 0 ? (
    <p className={mutedClass}>No evidence attached.</p>
  ) : (
    <ul aria-label="Evidence" className={listClass}>
      {evidence.map((item) => (
        <EvidenceItem key={item.evidenceId} item={item} addEvidencePath={addEvidencePath} />
      ))}
    </ul>
  );
