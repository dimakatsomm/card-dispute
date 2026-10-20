import { useId } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '../../app/routes';
import { LoadError } from '../../components/transactions/LoadError';
import { TransactionList } from '../../components/transactions/TransactionList';
import { AccountStatus, CardList, accountLabel } from '../home/accountDisplay';
import { findAccount, useMe } from '../home/useMe';

export const AccountScreen = () => {
  const { accountId = '' } = useParams();
  const me = useMe();
  const cardsHeading = useId();
  const transactionsHeading = useId();

  if (me.isPending) return <p role="status">Loading account…</p>;
  if (me.isError) return <LoadError message="We couldn't load this account." onRetry={() => void me.refetch()} />;

  const account = findAccount(me.data, accountId);
  if (!account) {
    return (
      <>
        <h1>Account not found</h1>
        <p>
          <Link to={routes.home()}>Back to your accounts</Link>
        </p>
      </>
    );
  }

  const label = accountLabel(account);
  return (
    <>
      <h1>
        {label}
        <AccountStatus account={account} />
      </h1>
      <section aria-labelledby={cardsHeading}>
        <h2 id={cardsHeading}>Cards</h2>
        <CardList cards={account.cards} label={`Cards on ${label}`} />
      </section>
      <section aria-labelledby={transactionsHeading}>
        <h2 id={transactionsHeading}>Transactions</h2>
        <TransactionList filter={{ accountId: account.accountId }} caption={`Transactions on ${label}`} />
      </section>
    </>
  );
};
