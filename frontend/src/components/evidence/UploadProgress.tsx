import { Link } from 'react-router';
import type { PreparedFile } from './core';
import type { FileUpload } from './useEvidenceUploads';

export type UploadProgressProps = {
  readonly uploads: ReadonlyArray<FileUpload>;
  readonly onRetry: (prepared: PreparedFile) => void;
  readonly detailPath: string;
};

export const UploadProgress = ({ uploads, onRetry, detailPath }: UploadProgressProps) => (
  <>
    <ul>
      {uploads.map(({ prepared, state }) => (
        <li key={prepared.key}>
          <span>{prepared.file.name}</span>{' '}
          {state.kind === 'uploading' ? (
            <progress max={100} value={Math.round(state.progress * 100)} aria-label={`Uploading ${prepared.file.name}`} />
          ) : null}
          {state.kind === 'done' ? <span>Uploaded</span> : null}
          {state.kind === 'failed' ? (
            <>
              <span role="alert">{state.message}</span>{' '}
              <button type="button" onClick={() => onRetry(prepared)}>
                Retry {prepared.file.name}
              </button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
    {uploads.some((f) => f.state.kind === 'failed') ? (
      <Link to={detailPath}>Go to your dispute without the failed files</Link>
    ) : null}
  </>
);
