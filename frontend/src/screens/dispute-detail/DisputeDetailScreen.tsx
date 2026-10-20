import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { routes } from '../../app/routes';
import type { Result } from '../../app/result';
import { formatMoney } from '../../lib/format/money';
import { formatDateTime, reasonLabel, statusLabel, type DisputeStatus } from '../disputes/labels';
import {
  loadDispute,
  updateDispute,
  type Dispute,
  type DisputeChange,
  type DisputeDetail,
  type UpdateError,
} from './api';
import { EditForm } from './EditForm';
import { EvidenceList } from './EvidenceList';
import { Timeline } from './Timeline';
import { WithdrawDialog } from './WithdrawDialog';

type Mode = 'view' | 'editing' | 'confirmingWithdraw';
type Notice = { readonly kind: 'success' | 'error'; readonly text: string };

const isOpen = (status: DisputeStatus) => status === 'SUBMITTED' || status === 'UNDER_REVIEW';
const isResolved = (status: DisputeStatus) => status === 'RESOLVED_ACCEPTED' || status === 'RESOLVED_REJECTED';

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
  <section aria-labelledby="transaction-heading">
    <h2 id="transaction-heading">Transaction</h2>
    {transaction ? (
      <dl>
        <dt>Merchant</dt>
        <dd>{transaction.merchantName}</dd>
        <dt>Amount</dt>
        <dd>{formatMoney(transaction.amount, transaction.currency)}</dd>
        <dt>Date</dt>
        <dd>
          <time dateTime={transaction.transactionAt}>{formatDateTime(transaction.transactionAt)}</time>
        </dd>
        <dt>Posted</dt>
        <dd>
          {transaction.postedAt ? (
            <time dateTime={transaction.postedAt}>{formatDateTime(transaction.postedAt)}</time>
          ) : (
            'Not posted'
          )}
        </dd>
      </dl>
    ) : (
      <p>Transaction details unavailable right now.</p>
    )}
  </section>
);

const Resolution = ({ dispute }: { readonly dispute: DisputeDetail }) =>
  isResolved(dispute.status) ? (
    <section aria-labelledby="resolution-heading">
      <h2 id="resolution-heading">Resolution</h2>
      <p>{statusLabel[dispute.status]}</p>
      {dispute.resolvedAt ? (
        <p>
          Resolved <time dateTime={dispute.resolvedAt}>{formatDateTime(dispute.resolvedAt)}</time>
        </p>
      ) : null}
      {dispute.resolutionNote ? <p>{dispute.resolutionNote}</p> : null}
    </section>
  ) : null;

const DisputeView = ({
  transactionId,
  dispute,
  etag,
}: {
  readonly transactionId: string;
  readonly dispute: DisputeDetail;
  readonly etag: string;
}) => {
  const api = useApi();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [notice, setNotice] = useState<Notice | null>(null);

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
    <section aria-labelledby="dispute-heading">
      <h1 id="dispute-heading">Dispute: {dispute.transaction?.merchantName ?? 'transaction details unavailable'}</h1>
      <p>
        <Link to={routes.disputes()}>Back to your disputes</Link>
      </p>
      {notice ? (
        <p role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>
      ) : null}
      <TransactionSummary transaction={dispute.transaction} />
      <section aria-labelledby="details-heading">
        <h2 id="details-heading">Dispute details</h2>
        <dl>
          <dt>Status</dt>
          <dd>{statusLabel[dispute.status]}</dd>
          <dt>Reason</dt>
          <dd>{reasonLabel[dispute.reasonCode]}</dd>
          <dt>Description</dt>
          <dd>{dispute.description}</dd>
          <dt>Submitted</dt>
          <dd>
            <time dateTime={dispute.createdAt}>{formatDateTime(dispute.createdAt)}</time>
          </dd>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={dispute.updatedAt}>{formatDateTime(dispute.updatedAt)}</time>
          </dd>
        </dl>
        {mode === 'view' && dispute.status === 'SUBMITTED' ? (
          <button type="button" onClick={() => setMode('editing')}>
            Edit dispute
          </button>
        ) : null}
        {mode === 'view' && isOpen(dispute.status) ? (
          <button type="button" onClick={() => setMode('confirmingWithdraw')}>
            Withdraw dispute
          </button>
        ) : null}
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
      <section aria-labelledby="evidence-heading">
        <h2 id="evidence-heading">Evidence</h2>
        <EvidenceList evidence={dispute.evidence} />
        {isOpen(dispute.status) ? (
          <Link to={routes.addEvidence(transactionId)}>Add evidence</Link>
        ) : null}
      </section>
      <Timeline events={dispute.timeline} />
    </section>
  );
};

export const DisputeDetailScreen = () => {
  const api = useApi();
  const { transactionId = '' } = useParams();
  const query = useQuery({
    queryKey: ['dispute', transactionId],
    queryFn: () => loadDispute(api)(transactionId),
  });

  if (query.isPending) return <p role="status">Loading dispute…</p>;
  if (query.isError || !query.data.ok) {
    const notFound = query.data?.ok === false && query.data.error === 'NOT_FOUND';
    return (
      <section role="alert">
        <h1>{notFound ? 'Dispute not found' : 'We could not load this dispute'}</h1>
        {notFound ? null : (
          <button type="button" onClick={() => void query.refetch()}>
            Try again
          </button>
        )}
        <Link to={routes.disputes()}>Back to your disputes</Link>
      </section>
    );
  }
  return <DisputeView transactionId={transactionId} dispute={query.data.value.dispute} etag={query.data.value.etag} />;
};
