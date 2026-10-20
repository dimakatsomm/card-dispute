import { useId } from 'react';
import { Link } from 'react-router';
import { routes } from '../../app/routes';
import { LoadError } from '../../components/transactions/LoadError';
import { TransactionList } from '../../components/transactions/TransactionList';
import { AccountStatus, CardList, accountLabel } from './accountDisplay';
import { useMe, type Me } from './useMe';

const AccountList = ({ me }: { readonly me: Me }) =>
  me.accounts.length === 0 ? (
    <p>You have no accounts yet.</p>
  ) : (
    <ul aria-label="Accounts">
      {me.accounts.map((account) => (
        <li key={account.accountId}>
          <h3>
            <Link to={routes.account(account.accountId)}>{accountLabel(account)}</Link>
            <AccountStatus account={account} />
          </h3>
          <CardList cards={account.cards} label={`Cards on ${accountLabel(account)}`} />
        </li>
      ))}
    </ul>
  );

export const HomeScreen = () => {
  const me = useMe();
  const accountsHeading = useId();
  const recentHeading = useId();
  return (
    <>
      <h1>{me.data ? `Hello, ${me.data.name}` : 'Your accounts'}</h1>
      <section aria-labelledby={accountsHeading}>
        <h2 id={accountsHeading}>Accounts</h2>
        {me.isPending ? <p role="status">Loading your accounts…</p> : null}
        {me.isError ? <LoadError message="We couldn't load your accounts." onRetry={() => void me.refetch()} /> : null}
        {me.data ? <AccountList me={me.data} /> : null}
      </section>
      <section aria-labelledby={recentHeading}>
        <h2 id={recentHeading}>Recent transactions</h2>
        <TransactionList filter={{}} caption="Recent transactions across all your accounts" />
      </section>
    </>
  );
};
