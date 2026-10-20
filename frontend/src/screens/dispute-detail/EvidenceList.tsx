import { Link } from 'react-router';
import { describeRejection, evidenceStatusLabel } from '../disputes/labels';
import type { Evidence } from './api';

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const EvidenceItem = ({ item, addEvidencePath }: { readonly item: Evidence; readonly addEvidencePath: string | null }) => {
  if (item.status === 'ERASED') return <li>File removed under our retention policy.</li>;
  return (
    <li>
      <span>{item.fileName}</span> <span>({formatSize(item.sizeBytes)})</span>{' '}
      <span>{evidenceStatusLabel[item.status]}</span>
      {item.status === 'REJECTED' ? <span>: {describeRejection(item.rejectionReason)}</span> : null}
      {item.status === 'EXPIRED' && addEvidencePath ? (
        <>
          {' '}
          <span>
            You can <Link to={addEvidencePath}>upload it again</Link>.
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
    <p>No evidence attached.</p>
  ) : (
    <ul aria-label="Evidence">
      {evidence.map((item) => (
        <EvidenceItem key={item.evidenceId} item={item} addEvidencePath={addEvidencePath} />
      ))}
    </ul>
  );
