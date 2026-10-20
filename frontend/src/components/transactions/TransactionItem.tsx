import { Link } from 'react-router';
import { routes } from '../../app/routes';
import { formatMoney } from '../../lib/format/money';
import { formatDate } from './format';
import { disputeStatusLabels, transactionStatusLabels, transactionTypeLabels } from './labels';
import { reasonMessage } from './reasons';
import type { TransactionRow } from './types';

type DisputeCellProps = { readonly row: TransactionRow; readonly amount: string; readonly date: string };

const DisputeCell = ({ row, amount, date }: DisputeCellProps) => (
  <>
    {row.dispute ? (
      <p>
        <Link to={routes.disputeDetail(row.transactionId)}>{disputeStatusLabels[row.dispute.status]}</Link>
      </p>
    ) : null}
    {row.disputable.allowed ? (
      <Link to={routes.disputeForm(row.transactionId)} aria-label={`Dispute ${row.merchantName}, ${amount} on ${date}`}>
        Dispute
      </Link>
    ) : (
      <p>{reasonMessage(row.disputable.reason)}</p>
    )}
  </>
);

export const TransactionItem = ({ row }: { readonly row: TransactionRow }) => {
  const amount = formatMoney(row.amount, row.currency);
  const date = formatDate(row.transactionAt);
  return (
    <tr>
      <td>
        <time dateTime={row.transactionAt}>{date}</time>
      </td>
      <th scope="row">{row.merchantName}</th>
      <td>{transactionTypeLabels[row.type]}</td>
      <td>{amount}</td>
      <td>{transactionStatusLabels[row.status]}</td>
      <td>
        <DisputeCell row={row} amount={amount} date={date} />
      </td>
    </tr>
  );
};
