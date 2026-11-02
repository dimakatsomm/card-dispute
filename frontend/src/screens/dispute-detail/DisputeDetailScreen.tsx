import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { routes } from '../../app/routes';
import type { Result } from '../../app/result';
import {
  Badge,
  Button,
  ButtonLink,
  Loading,
  PageHeader,
  cardClass,
  cx,
  definitionListClass,
  disputeStatusTone,
  errorBannerClass,
  linkClass,
  mutedClass,
  panelClass,
  sectionTitleClass,
  successBannerClass,
  termClass,
} from '../../components/ui';
import { formatMoney } from '../../lib/format/money';
import { formatDateTime, reasonLabel, statusLabel } from '../disputes/labels';
import {
  updateDispute,
  type Dispute,
  type DisputeChange,
  type DisputeDetail,
  type UpdateError,
} from './api';
import { isErased, isOpen, isResolved, visibleText } from './core';
import { EditForm } from './EditForm';
import { EvidenceList } from './EvidenceList';
import { useChangeAnnouncement, useDispute } from './hooks';
import { Timeline } from './Timeline';
import { WithdrawDialog } from './WithdrawDialog';

type Mode = 'view' | 'editing' | 'confirmingWithdraw';
type Notice = { readonly kind: 'success' | 'error'; readonly text: string };

const updateErrorMessage: Readonly<Record<UpdateError, string>> = {
  STALE: 'This dispute changed, please review it before trying again.',
  INVALID_TRANSITION: 'This dispute can no longer be changed that way. It now shows its current status.',
  INVALID_INPUT: 'Please check the reason and description (10 to 2000 characters) and try again.',
  NOT_FOUND: 'This dispute could not be found.',
  FAILED: 'Something went wrong. Please try again.',
};

const successMessage = (change: DisputeChange): string =>
  change.action === 'WITHDRAW' ? 'Your dispute has been withdrawn.' : 'Your changes have been saved.';

const TransactionSummary = ({ transaction }: { readonly transaction: DisputeDetail['transaction'] }) => (
  <section aria-labelledby="transaction-heading" className={panelClass}>
    <h2 id="transaction-heading" className={sectionTitleClass}>
      Transaction
    </h2>
    {transaction ? (
      <dl className={definitionListClass}>
        <dt className={termClass}>Merchant</dt>
        <dd>{transaction.merchantName}</dd>
        <dt className={termClass}>Amount</dt>
        <dd className="font-semibold tabular-nums">
          {formatMoney(transaction.amount, transaction.currency)}
        </dd>
        <dt className={termClass}>Date</dt>
        <dd>
          <time dateTime={transaction.transactionAt}>{formatDateTime(transaction.transactionAt)}</time>
        </dd>
        <dt className={termClass}>Posted</dt>
        <dd>
          {transaction.postedAt ? (
            <time dateTime={transaction.postedAt}>{formatDateTime(transaction.postedAt)}</time>
          ) : (
            'Not posted'
          )}
        </dd>
      </dl>
    ) : (
      <p className={mutedClass}>Transaction details unavailable right now.</p>
    )}
  </section>
);

const Resolution = ({ dispute }: { readonly dispute: DisputeDetail }) => {
  const note = visibleText(dispute.resolutionNote);
  return isResolved(dispute.status) ? (
    <section aria-labelledby="resolution-heading" className={panelClass}>
      <h2 id="resolution-heading" className={sectionTitleClass}>
        Resolution
      </h2>
      <p>
        <Badge tone={disputeStatusTone[dispute.status]}>{statusLabel[dispute.status]}</Badge>
      </p>
      {dispute.resolvedAt ? (
        <p className={mutedClass}>
          Resolved <time dateTime={dispute.resolvedAt}>{formatDateTime(dispute.resolvedAt)}</time>
        </p>
      ) : null}
      {note ? <p className="rounded-lg bg-zinc-50 px-4 py-3 text-sm text-ink">Note from the bank: {note}</p> : null}
    </section>
  ) : null;
};

const DisputeView = ({
  transactionId,
  dispute,
  etag,
  stillChecking,
  onRecheck,
}: {
  readonly transactionId: string;
  readonly dispute: DisputeDetail;
  readonly etag: string;
  readonly stillChecking: boolean;
  readonly onRecheck: () => void;
}) => {
  const api = useApi();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [notice, setNotice] = useState<Notice | null>(null);
  const announcement = useChangeAnnouncement(dispute);
  const erased = isErased(dispute);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dispute', transactionId] }),
      queryClient.invalidateQueries({ queryKey: ['disputes'] }),
    ]);

  const mutation = useMutation({
    mutationFn: (change: DisputeChange) => updateDispute(api)({ transactionId, etag, change }),
    onSuccess: (result: Result<Dispute, UpdateError>, change) => {
      if (result.ok) {
        setMode('view');
        setNotice({ kind: 'success', text: successMessage(change) });
        void refresh();
        return;
      }
      setNotice({ kind: 'error', text: updateErrorMessage[result.error] });
      if (result.error === 'INVALID_INPUT') return;
      setMode('view');
      void refresh();
    },
    onError: () => setNotice({ kind: 'error', text: updateErrorMessage.FAILED }),
  });

  const save = (change: DisputeChange) => {
    setNotice(null);
    mutation.mutate(change);
  };

  return (
    <section aria-labelledby="dispute-heading" className="mx-auto max-w-3xl">
      <PageHeader
        title={`Dispute: ${dispute.transaction?.merchantName ?? 'transaction details unavailable'}`}
        titleId="dispute-heading"
      >
        <p>
          <Link to={routes.disputes()} className={linkClass}>
            Back to your disputes
          </Link>
        </p>
      </PageHeader>
      <div className="space-y-6">
        {notice ? (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={notice.kind === 'error' ? errorBannerClass : successBannerClass}
          >
            {notice.text}
          </p>
        ) : null}
        <p aria-live="polite" aria-atomic="true" className="text-sm text-muted empty:sr-only">
          {announcement}
        </p>
        {erased ? (
          <p className="rounded-lg border border-line bg-zinc-100/60 px-4 py-3 text-sm text-zinc-700">
            Some details of this dispute were removed under our retention policy.
          </p>
        ) : null}
        <TransactionSummary transaction={dispute.transaction} />
        <section aria-labelledby="details-heading" className={panelClass}>
          <h2 id="details-heading" className={sectionTitleClass}>
            Dispute details
          </h2>
          <dl className={definitionListClass}>
            <dt className={termClass}>Status</dt>
            <dd>
              <Badge tone={disputeStatusTone[dispute.status]}>{statusLabel[dispute.status]}</Badge>
            </dd>
            <dt className={termClass}>Reason</dt>
            <dd>{reasonLabel[dispute.reasonCode]}</dd>
            <dt className={termClass}>Description</dt>
            <dd className="whitespace-pre-line break-words">
              {erased ? 'Removed under our retention policy' : dispute.description}
            </dd>
            <dt className={termClass}>Submitted</dt>
            <dd>
              <time dateTime={dispute.createdAt}>{formatDateTime(dispute.createdAt)}</time>
            </dd>
            <dt className={termClass}>Last updated</dt>
            <dd>
              <time dateTime={dispute.updatedAt}>{formatDateTime(dispute.updatedAt)}</time>
            </dd>
          </dl>
          <div className="flex flex-wrap gap-3 border-t border-line pt-4 empty:hidden">
            {mode === 'view' && dispute.status === 'SUBMITTED' ? (
              <Button variant="secondary" onClick={() => setMode('editing')}>
                Edit dispute
              </Button>
            ) : null}
            {mode === 'view' && isOpen(dispute.status) ? (
              <Button variant="dangerOutline" onClick={() => setMode('confirmingWithdraw')}>
                Withdraw dispute
              </Button>
            ) : null}
          </div>
          {mode === 'editing' && dispute.status === 'SUBMITTED' ? (
            <EditForm
              current={{ reasonCode: dispute.reasonCode, description: dispute.description }}
              pending={mutation.isPending}
              onSave={save}
              onCancel={() => setMode('view')}
            />
          ) : null}
          {mode === 'confirmingWithdraw' && isOpen(dispute.status) ? (
            <WithdrawDialog
              pending={mutation.isPending}
              onConfirm={() => save({ action: 'WITHDRAW' })}
              onCancel={() => setMode('view')}
            />
          ) : null}
        </section>
        <Resolution dispute={dispute} />
        <section aria-labelledby="evidence-heading" className={panelClass}>
          <h2 id="evidence-heading" className={sectionTitleClass}>
            Evidence
          </h2>
          <EvidenceList
            evidence={dispute.evidence}
            addEvidencePath={isOpen(dispute.status) ? routes.addEvidence(transactionId) : null}
          />
          {stillChecking ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-amber-50/70 px-4 py-3 text-sm text-amber-900">
              We are still checking your files. Refresh to see the latest status.{' '}
              <Button variant="secondary" size="sm" onClick={onRecheck}>
                Refresh
              </Button>
            </p>
          ) : null}
          {isOpen(dispute.status) ? (
            <ButtonLink to={routes.addEvidence(transactionId)} variant="secondary" size="sm">
              Add evidence
            </ButtonLink>
          ) : null}
        </section>
        <Timeline events={dispute.timeline} />
      </div>
    </section>
  );
};

export const DisputeDetailScreen = () => {
  const { transactionId = '' } = useParams();
  const { query, stillChecking, recheck } = useDispute(transactionId);

  if (query.isPending) return <Loading>Loading dispute…</Loading>;
  // A failed refetch after a good load keeps showing the dispute instead of replacing it with an error.
  if (!query.data?.ok) {
    const notFound = query.data?.ok === false && query.data.error === 'NOT_FOUND';
    return (
      <section role="alert" className={cx(cardClass, 'mx-auto max-w-xl space-y-4 p-6 text-center')}>
        <h1 className="text-xl font-semibold tracking-tight">
          {notFound ? 'Dispute not found' : 'We could not load this dispute'}
        </h1>
        <div className="flex flex-wrap items-center justify-center gap-4">
          {notFound ? null : <Button onClick={() => void query.refetch()}>Try again</Button>}
          <Link to={routes.disputes()} className={linkClass}>
            Back to your disputes
          </Link>
        </div>
      </section>
    );
  }
  return (
    <DisputeView
      key={transactionId}
      transactionId={transactionId}
      dispute={query.data.value.dispute}
      etag={query.data.value.etag}
      stillChecking={stillChecking}
      onRecheck={recheck}
    />
  );
};
