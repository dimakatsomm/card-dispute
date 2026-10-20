import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { routes } from '../../app/routes';
import {
  declareEvidence,
  FilePicker,
  UploadProgress,
  useEvidenceUploads,
  useFileSelection,
  type EvidenceDeps,
  type EvidenceFailure,
} from '../../components/evidence';

type Phase =
  | { readonly kind: 'choosing'; readonly error: string | null }
  | { readonly kind: 'declaring' }
  | { readonly kind: 'uploading' };

const DECLARE_FAILURE_MESSAGES: Readonly<Record<EvidenceFailure, string>> = {
  CLOSED: 'This dispute is closed, so no more files can be added.',
  TOO_MANY_FILES: 'This dispute already has the maximum number of files waiting or stored.',
  NOT_FOUND: "We couldn't find this dispute.",
  UNAVAILABLE: 'The service is temporarily unavailable. Try again in a moment.',
  UNEXPECTED: 'Something went wrong. Try again.',
};

export type AddEvidenceFormProps = { readonly transactionId: string; readonly deps: EvidenceDeps };

export const AddEvidenceForm = ({ transactionId, deps }: AddEvidenceFormProps) => {
  const navigate = useNavigate();
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'choosing', error: null });
  const selection = useFileSelection();
  const uploads = useEvidenceUploads(transactionId, deps);
  const declare = useMemo(() => declareEvidence(deps), [deps]);
  const detailPath = routes.disputeDetail(transactionId);

  useEffect(() => {
    if (uploads.allDone) void navigate(detailPath, { replace: true });
  }, [uploads.allDone, detailPath, navigate]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selection.files.length === 0) {
      setPhase({ kind: 'choosing', error: 'Choose at least one file.' });
      return;
    }
    setPhase({ kind: 'declaring' });
    const result = await declare({ transactionId, files: selection.files }).catch(() => null);
    if (!result || !result.ok) {
      setPhase({ kind: 'choosing', error: DECLARE_FAILURE_MESSAGES[result ? result.error : 'UNEXPECTED'] });
      return;
    }
    setPhase({ kind: 'uploading' });
    uploads.start(result.value);
  };

  if (phase.kind === 'uploading') {
    return (
      <section aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`}>Add evidence</h1>
        <p role="status">Uploading your files…</p>
        <UploadProgress
          uploads={uploads.uploads ?? []}
          onRetry={(prepared) => void uploads.retry(prepared)}
          detailPath={detailPath}
        />
      </section>
    );
  }

  const declaring = phase.kind === 'declaring';
  const error = phase.kind === 'choosing' ? phase.error : null;
  return (
    <section aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>Add evidence</h1>
      {error ? <p role="alert">{error}</p> : null}
      <form noValidate onSubmit={(event) => void onSubmit(event)}>
        <FilePicker label="Files" selection={selection} disabled={declaring} />
        <button type="submit" disabled={declaring}>
          {declaring ? 'Adding…' : 'Add files'}
        </button>
      </form>
      <Link to={detailPath}>Back to your dispute</Link>
    </section>
  );
};
