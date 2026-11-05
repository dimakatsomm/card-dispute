import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { ok, type Result } from '../../app/result';
import { agentRoutes } from '../../app/routes';
import {
  Badge,
  Button,
  Loading,
  PageHeader,
  cardClass,
  cx,
  definitionListClass,
  disputeStatusTone,
  errorBannerClass,
  evidenceStatusTone,
  linkClass,
  listClass,
  mutedClass,
  panelClass,
  sectionTitleClass,
  successBannerClass,
  termClass,
} from '../../components/ui';
import { formatMoney } from '../../lib/format/money';
import { agentStatusLabel } from '../agent-queue/labels';
import { evidenceStatusLabel, formatDateTime, reasonLabel } from '../disputes/labels';
import {
  loadAgentDispute,
  pickUpDispute,
  resolveDispute,
  type ActionError,
  type AgentDispute,
  type LoadError,
  type Outcome,
} from './api';
import { AgentTimeline } from './AgentTimeline';
import { expectedFrom, isOpen } from './core';
import { EvidenceDownload } from './EvidenceDownload';
import { ResolveForm } from './ResolveForm';

type Loaded = Result<AgentDispute, LoadError>;
type Notice = { readonly kind: 'success' | 'error'; readonly text: string };
type Action = { readonly kind: 'pickUp' } | { readonly kind: 'resolve'; readonly outcome: Outcome; readonly note: string };

const actionErrorMessage: Readonly<Record<ActionError, string>> = {
  STALE: 'This dispute changed since you opened it. The latest version is shown below; review it before trying again.',
  INVALID_TRANSITION: 'This dispute can no longer be changed that way. It now shows its current state.',
  INVALID_INPUT: 'The note must be between 10 and 2000 characters.',
  NOT_FOUND: 'This dispute could not be found.',
  FAILED: 'Something went wrong. Please try again.',
};

const successMessage = (action: Action): string => {
  if (action.kind === 'pickUp') return 'You picked up this dispute.';
  return action.outcome === 'ACCEPTED' ? 'Dispute resolved: accepted.' : 'Dispute resolved: rejected.';
};

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const disputeKey = (transactionId: string) => ['agent', 'dispute', transactionId] as const;

const TransactionSummary = ({ transaction }: { readonly transaction: AgentDispute['transaction'] }) => (
  <section aria-labelledby="agent-transaction-heading" className={panelClass}>
    <h2 id="agent-transaction-heading" className={sectionTitleClass}>
      Transaction
    </h2>
    {transaction ? (
      <dl className={definitionListClass}>
        <dt className={termClass}>Merchant</dt>
        <dd>{transaction.merchantName}</dd>
        <dt className={termClass}>Amount</dt>
        <dd className="font-semibold tabular-nums">{formatMoney(transaction.amount, transaction.currency)}</dd>
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

// Download only: untrusted files are never previewed inline (ADR-072).
const EvidenceList = ({
  transactionId,
  evidence,
  onStale,
}: {
  readonly transactionId: string;
  readonly evidence: AgentDispute['evidence'];
  readonly onStale: () => void;
}) => (
  <section aria-labelledby="agent-evidence-heading" className={panelClass}>
    <h2 id="agent-evidence-heading" className={sectionTitleClass}>
      Evidence
    </h2>
    {evidence.length === 0 ? (
      <p className={mutedClass}>No evidence attached.</p>
    ) : (
      <ul aria-label="Evidence" className={listClass}>
        {evidence.map((item) => (
          <li key={item.evidenceId} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
            {item.status === 'ERASED' ? (
              <span className="text-muted">File removed under the retention policy.</span>
            ) : (
              <>
                <span>
                  <span className="font-medium break-all text-ink">{item.fileName}</span>{' '}
                  <span className="text-muted tabular-nums">({formatSize(item.sizeBytes)})</span>{' '}
                  <Badge tone={evidenceStatusTone[item.status]} className="align-middle">
                    {evidenceStatusLabel[item.status]}
                  </Badge>
                </span>
                <EvidenceDownload
                  transactionId={transactionId}
                  evidenceId={item.evidenceId}
                  fileName={item.fileName}
                  downloadable={item.status === 'STORED'}
                  onStale={onStale}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    )}
  </section>
);

const AgentDisputeView = ({ transactionId, dispute }: { readonly transactionId: string; readonly dispute: AgentDispute }) => {
  const api = useApi();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: disputeKey(transactionId) }),
      queryClient.invalidateQueries({ queryKey: ['agent', 'queue'] }),
    ]);

  const mutation = useMutation({
    mutationFn: (action: Action) => {
      const expected = expectedFrom(dispute);
      return action.kind === 'pickUp'
        ? pickUpDispute(api)({ transactionId, expected })
        : resolveDispute(api)({ transactionId, expected, outcome: action.outcome, note: action.note });
    },
    onSuccess: (result: Result<AgentDispute, ActionError>, action) => {
      if (result.ok) {
        queryClient.setQueryData<Loaded>(disputeKey(transactionId), ok(result.value));
        void queryClient.invalidateQueries({ queryKey: ['agent', 'queue'] });
        setNotice({ kind: 'success', text: successMessage(action) });
        return;
      }
      setNotice({ kind: 'error', text: actionErrorMessage[result.error] });
      if (result.error !== 'INVALID_INPUT') void reload();
    },
    onError: () => setNotice({ kind: 'error', text: actionErrorMessage.FAILED }),
  });

  const run = (action: Action) => {
    setNotice(null);
    mutation.mutate(action);
  };

  return (
    <section aria-labelledby="agent-dispute-heading" className="mx-auto max-w-3xl">
      <PageHeader
        title={`Dispute: ${dispute.transaction?.merchantName ?? 'transaction details unavailable'}`}
        titleId="agent-dispute-heading"
      >
        <p>
          <Link to={agentRoutes.queue()} className={linkClass}>
            Back to the review queue
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
        <section aria-labelledby="agent-details-heading" className={panelClass}>
          <h2 id="agent-details-heading" className={sectionTitleClass}>
            Dispute details
          </h2>
          <dl className={definitionListClass}>
            <dt className={termClass}>Status</dt>
            <dd>
              <Badge tone={disputeStatusTone[dispute.status]}>{agentStatusLabel[dispute.status]}</Badge>
            </dd>
            <dt className={termClass}>Reason</dt>
            <dd>{reasonLabel[dispute.reasonCode]}</dd>
            <dt className={termClass}>Description</dt>
            <dd className="whitespace-pre-line break-words">{dispute.description}</dd>
            <dt className={termClass}>Opened</dt>
            <dd>
              <time dateTime={dispute.createdAt}>{formatDateTime(dispute.createdAt)}</time>
            </dd>
            <dt className={termClass}>Last updated</dt>
            <dd>
              <time dateTime={dispute.updatedAt}>{formatDateTime(dispute.updatedAt)}</time>
            </dd>
          </dl>
          {dispute.pickedUpBy ? <p className="text-sm text-ink">Picked up by {dispute.pickedUpBy}</p> : null}
          {dispute.resolutionNote ? (
            <p className="rounded-lg bg-zinc-50 px-4 py-3 text-sm text-ink">
              Resolution note: {dispute.resolutionNote}
            </p>
          ) : null}
          {dispute.status === 'SUBMITTED' ? (
            <div className="border-t border-line pt-4">
              <Button disabled={mutation.isPending} onClick={() => run({ kind: 'pickUp' })}>
                Pick up
              </Button>
            </div>
          ) : null}
          {isOpen(dispute.status) ? (
            <ResolveForm pending={mutation.isPending} onResolve={(input) => run({ kind: 'resolve', ...input })} />
          ) : null}
        </section>
        <TransactionSummary transaction={dispute.transaction} />
        <EvidenceList transactionId={transactionId} evidence={dispute.evidence} onStale={() => void reload()} />
        <AgentTimeline events={dispute.timeline} />
      </div>
    </section>
  );
};

export const AgentDisputeScreen = () => {
  const { transactionId = '' } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: disputeKey(transactionId),
    queryFn: async (): Promise<Loaded> => {
      const result = await loadAgentDispute(api)(transactionId);
      const previous = queryClient.getQueryData<Loaded>(disputeKey(transactionId));
      // A failed reload keeps the loaded dispute so a draft note survives.
      return !result.ok && previous?.ok ? previous : result;
    },
  });

  if (query.isPending) return <Loading>Loading dispute…</Loading>;
  if (!query.data?.ok) {
    const notFound = query.data?.ok === false && query.data.error === 'NOT_FOUND';
    return (
      <section role="alert" className={cx(cardClass, 'mx-auto max-w-xl space-y-4 p-6 text-center')}>
        <h1 className="text-xl font-semibold tracking-tight">
          {notFound ? 'Dispute not found' : 'We could not load this dispute'}
        </h1>
        <div className="flex flex-wrap items-center justify-center gap-4">
          {notFound ? null : <Button onClick={() => void query.refetch()}>Try again</Button>}
          <Link to={agentRoutes.queue()} className={linkClass}>
            Back to the review queue
          </Link>
        </div>
      </section>
    );
  }
  return <AgentDisputeView key={transactionId} transactionId={transactionId} dispute={query.data.value} />;
};
