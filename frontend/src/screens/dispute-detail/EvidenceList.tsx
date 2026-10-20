import { describeRejection, evidenceStatusLabel } from '../disputes/labels';
import type { Evidence } from './api';

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const EvidenceList = ({ evidence }: { readonly evidence: ReadonlyArray<Evidence> }) =>
  evidence.length === 0 ? (
    <p>No evidence attached.</p>
  ) : (
    <ul aria-label="Evidence">
      {evidence.map((item) => (
        <li key={item.evidenceId}>
          <span>{item.fileName}</span> <span>({formatSize(item.sizeBytes)})</span>{' '}
          <span>{evidenceStatusLabel[item.status]}</span>
          {item.status === 'REJECTED' ? <span>: {describeRejection(item.rejectionReason)}</span> : null}
        </li>
      ))}
    </ul>
  );
