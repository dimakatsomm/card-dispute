import { useQueryClient } from '@tanstack/react-query';
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
import {
  Button,
  Field,
  FieldError,
  Hint,
  Label,
  PageHeader,
  Select,
  TextArea,
  cardClass,
  cx,
  errorBannerClass,
  successBannerClass,
} from '../../components/ui';
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
  const queryClient = useQueryClient();
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
    if (result.ok || result.error.kind === 'ALREADY_DISPUTED') {
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
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
      <section aria-labelledby={`${id}-title`} className="mx-auto max-w-2xl space-y-6">
        <PageHeader title="Dispute a transaction" titleId={`${id}-title`} />
        <p role="status" className={successBannerClass}>
          Your dispute has been submitted. Uploading your files…
        </p>
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
    <section aria-labelledby={`${id}-title`} className="mx-auto max-w-2xl">
      <PageHeader title="Dispute a transaction" titleId={`${id}-title`}>
        <p>The dispute covers the full amount of the transaction.</p>
      </PageHeader>
      <div className="space-y-6">
        {submitError ? (
          <p role="alert" className={errorBannerClass}>
            {submitError}
          </p>
        ) : null}
        <form noValidate onSubmit={(event) => void onSubmit(event)} className={cx(cardClass, 'space-y-6 p-5 sm:p-6')}>
          <Field>
            <Label htmlFor={ids.reason}>Reason</Label>
            <Select
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
            </Select>
            {reasonError ? <FieldError id={ids.reasonError}>{reasonError}</FieldError> : null}
          </Field>

          <Field>
            <Label htmlFor={ids.description}>What happened?</Label>
            <TextArea
              id={ids.description}
              ref={descriptionRef}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              aria-invalid={descriptionError ? true : undefined}
              aria-describedby={describedBy(ids.descriptionCount, descriptionError ? ids.descriptionError : null)}
              required
            />
            <Hint id={ids.descriptionCount} className="tabular-nums">
              {codePointLength(description)} / {DESCRIPTION_MAX} characters (at least {DESCRIPTION_MIN})
            </Hint>
            {descriptionError ? <FieldError id={ids.descriptionError}>{descriptionError}</FieldError> : null}
          </Field>

          <FilePicker label="Evidence (optional)" selection={selection} disabled={submitting} />

          <div className="flex justify-end border-t border-line pt-5">
            <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
              {submitting ? 'Submitting…' : 'Submit dispute'}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
};
