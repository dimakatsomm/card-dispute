import { Link } from 'react-router';
import { Badge, Button, cardClass, cx, errorClass, linkClass } from '../ui';
import type { PreparedFile } from './core';
import type { FileUpload } from './useEvidenceUploads';

export type UploadProgressProps = {
  readonly uploads: ReadonlyArray<FileUpload>;
  readonly onRetry: (prepared: PreparedFile) => void;
  readonly detailPath: string;
};

const progressClass = cx(
  'h-1.5 w-full appearance-none overflow-hidden rounded-full bg-zinc-200',
  '[&::-webkit-progress-bar]:bg-zinc-200 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent',
  '[&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-accent',
  'motion-safe:[&::-webkit-progress-value]:transition-[width] motion-safe:[&::-webkit-progress-value]:duration-300',
);

export const UploadProgress = ({ uploads, onRetry, detailPath }: UploadProgressProps) => (
  <div className="space-y-4">
    <ul className={cx(cardClass, 'divide-y divide-zinc-100')}>
      {uploads.map(({ prepared, state }) => (
        <li key={prepared.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
          <span className="min-w-0 flex-1 font-medium text-ink [overflow-wrap:anywhere]">{prepared.file.name}</span>{' '}
          {state.kind === 'uploading' ? (
            <progress
              max={100}
              value={Math.round(state.progress * 100)}
              aria-label={`Uploading ${prepared.file.name}`}
              className={cx(progressClass, 'basis-full')}
            />
          ) : null}
          {state.kind === 'done' ? <Badge tone="success">Uploaded</Badge> : null}
          {state.kind === 'failed' ? (
            <>
              <span role="alert" className={cx(errorClass, 'basis-full sm:order-last')}>
                {state.message}
              </span>{' '}
              <Button variant="secondary" size="sm" wrap onClick={() => onRetry(prepared)}>
                Retry {prepared.file.name}
              </Button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
    {uploads.some((f) => f.state.kind === 'failed') ? (
      <Link to={detailPath} className={linkClass}>
        Go to your dispute without the failed files
      </Link>
    ) : null}
  </div>
);
