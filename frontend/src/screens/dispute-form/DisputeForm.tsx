import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { routes } from '../../app/routes';
import {
  codePointLength,
  FilePicker,
  UploadProgress,
  useEvidenceUploads,
  useFileSelection,
} from '../../components/evidence';
import { isReasonCode, REASON_CODES, type ReasonCode } from '../../lib/dispute-reasons';
import {
  checkDescription,
  createFailureMessage,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  REASON_LABELS,
  type DescriptionProblem,
} from './core';
import { submitDispute, type DisputeFormDeps } from './use-cases';

type Phase =
  | { readonly kind: 'editing'; readonly submitError: string | null }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'uploading' };

const DESCRIPTION_MESSAGES: Readonly<Record<DescriptionProblem, string>> = {
  TOO_SHORT: `Enter at least ${DESCRIPTION_MIN} characters.`,
  TOO_LONG: `Enter no more than ${DESCRIPTION_MAX} characters.`,
};

const describedBy = (...ids: ReadonlyArray<string | null>): string => ids.filter((id) => id !== null).join(' ');

export type DisputeFormProps = { readonly transactionId: string; readonly deps: DisputeFormDeps };

export const DisputeForm = ({ transactionId, deps }: DisputeFormProps) => {
  const navigate = useNavigate();
  const id = useId();
  const reasonRef = useRef<HTMLSelectElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const [reason, setReason] = useState<ReasonCode | ''>('');
  const [description, setDescription] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing', submitError: null });
  const selection = useFileSelection();
  const uploads = useEvidenceUploads(transactionId, deps);

  const submit = useMemo(() => submitDispute(deps), [deps]);
  const detailPath = routes.disputeDetail(transactionId);

  const reasonError = attempted && reason === '' ? 'Choose a reason.' : null;
  const descriptionProblem = checkDescription(description);
  const descriptionError = attempted && descriptionProblem ? DESCRIPTION_MESSAGES[descriptionProblem] : null;

  useEffect(() => {
    if (uploads.allDone) void navigate(detailPath, { replace: true });
  }, [uploads.allDone, detailPath, navigate]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (reason === '') {
      reasonRef.current?.focus();
      return;
    }
    if (descriptionProblem) {
      descriptionRef.current?.focus();
      return;
    }
    setPhase({ kind: 'submitting' });
    const result = await submit({ transactionId, reasonCode: reason, description, files: selection.files }).catch(
      () => null,
    );
    if (!result) {
      setPhase({ kind: 'editing', submitError: createFailureMessage({ kind: 'UNEXPECTED' }) });
      return;
    }
    if (!result.ok) {
      if (result.error.kind === 'ALREADY_DISPUTED') {
        void navigate(detailPath, { replace: true });
        return;
      }
      setPhase({ kind: 'editing', submitError: createFailureMessage(result.error) });
      return;
    }
    setPhase({ kind: 'uploading' });
    uploads.start(result.value);
  };

  if (phase.kind === 'uploading') {
    return (
      <section aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`}>Dispute a transaction</h1>
        <p role="status">Your dispute has been submitted. Uploading your files…</p>
        <UploadProgress
          uploads={uploads.uploads ?? []}
          onRetry={(prepared) => void uploads.retry(prepared)}
          detailPath={detailPath}
        />
      </section>
    );
  }

  const submitting = phase.kind === 'submitting';
  const submitError = phase.kind === 'editing' ? phase.submitError : null;
  const ids = {
    reason: `${id}-reason`,
    reasonError: `${id}-reason-error`,
    description: `${id}-description`,
    descriptionCount: `${id}-description-count`,
    descriptionError: `${id}-description-error`,
  };

  return (
    <section aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>Dispute a transaction</h1>
      <p>The dispute covers the full amount of the transaction.</p>
      {submitError ? <p role="alert">{submitError}</p> : null}
      <form noValidate onSubmit={(event) => void onSubmit(event)}>
        <div>
          <label htmlFor={ids.reason}>Reason</label>
          <select
            id={ids.reason}
            ref={reasonRef}
            value={reason}
            onChange={(event) => setReason(isReasonCode(event.currentTarget.value) ? event.currentTarget.value : '')}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? ids.reasonError : undefined}
            required
          >
            <option value="">Choose a reason</option>
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {REASON_LABELS[code]}
              </option>
            ))}
          </select>
          {reasonError ? <p id={ids.reasonError}>{reasonError}</p> : null}
        </div>

        <div>
          <label htmlFor={ids.description}>What happened?</label>
          <textarea
            id={ids.description}
            ref={descriptionRef}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            aria-invalid={descriptionError ? true : undefined}
            aria-describedby={describedBy(ids.descriptionCount, descriptionError ? ids.descriptionError : null)}
            required
          />
          <p id={ids.descriptionCount}>
            {codePointLength(description)} / {DESCRIPTION_MAX} characters (at least {DESCRIPTION_MIN})
          </p>
          {descriptionError ? <p id={ids.descriptionError}>{descriptionError}</p> : null}
        </div>

        <FilePicker label="Evidence (optional)" selection={selection} disabled={submitting} />

        <button type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit dispute'}
        </button>
      </form>
    </section>
  );
};
