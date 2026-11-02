import { useId } from 'react';
import { Link } from 'react-router';
import { routes } from '../../app/routes';
import { formatMoney } from '../../lib/format/money';
import { Badge, ButtonLink, badgeClass, cx, disputeStatusTone, focusRing, transactionStatusTone } from '../ui';
import { formatDate } from './format';
import { disputeStatusLabels, transactionStatusLabels, transactionTypeLabels } from './labels';
import { reasonMessage } from './reasons';
import { bodyCellClass } from './tableClasses';
import type { TransactionRow } from './types';

type DisputeCellProps = { readonly row: TransactionRow; readonly amount: string; readonly date: string };

const DisputeCell = ({ row, amount, date }: DisputeCellProps) => (
  <div className="flex flex-col items-end gap-1.5">
    {row.dispute ? (
      <p>
        <Link
          to={routes.disputeDetail(row.transactionId)}
          className={cx(
            badgeClass(disputeStatusTone[row.dispute.status]),
            'hover:underline max-sm:rounded-md max-sm:text-right max-sm:whitespace-normal',
            focusRing,
          )}
        >
          {disputeStatusLabels[row.dispute.status]}
        </Link>
      </p>
    ) : null}
    {row.disputable.allowed ? (
      <ButtonLink
        to={routes.disputeForm(row.transactionId)}
        size="sm"
        aria-label={`Dispute ${row.merchantName}, ${amount} on ${date}`}
      >
        Dispute
      </ButtonLink>
    ) : (
      <p className="max-w-36 text-right text-xs break-words text-muted sm:max-w-56">
        {reasonMessage(row.disputable.reason)}
      </p>
    )}
  </div>
);

export const TransactionItem = ({ row }: { readonly row: TransactionRow }) => {
  const merchantId = useId();
  const amount = formatMoney(row.amount, row.currency);
  const date = formatDate(row.transactionAt);
  const status = transactionStatusLabels[row.status];
  return (
    <tr className="motion-safe:transition-colors hover:bg-zinc-50/70">
      <td className={cx(bodyCellClass('date'), 'text-muted tabular-nums')}>
        <time dateTime={row.transactionAt}>{date}</time>
      </td>
      {/* Named by the merchant alone so the narrow-screen summary line never changes the row header's name. */}
      <th scope="row" aria-labelledby={merchantId} className={cx(bodyCellClass('merchant'), 'font-medium text-ink sm:min-w-40')}>
        <span id={merchantId} className="break-words">
          {row.merchantName}
        </span>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-normal text-muted sm:hidden">
          <time dateTime={row.transactionAt} className="tabular-nums">
            {date}
          </time>
          <span aria-hidden="true">·</span>
          <span>{transactionTypeLabels[row.type]}</span>
          <Badge tone={transactionStatusTone[row.status]}>{status}</Badge>
        </div>
      </th>
      <td className={cx(bodyCellClass('type'), 'text-zinc-600')}>{transactionTypeLabels[row.type]}</td>
      <td className={cx(bodyCellClass('amount'), 'font-medium text-ink tabular-nums')}>{amount}</td>
      <td className={bodyCellClass('status')}>
        <Badge tone={transactionStatusTone[row.status]}>{status}</Badge>
      </td>
      <td className={bodyCellClass('dispute')}>
        <DisputeCell row={row} amount={amount} date={date} />
      </td>
    </tr>
  );
};
