import { useId } from 'react';
import { Link } from 'react-router';
import { routes } from '../../app/routes';
import { LoadError } from '../../components/transactions/LoadError';
import { TransactionList } from '../../components/transactions/TransactionList';
import { Empty, Loading, PageHeader, cardClass, cx, focusRing, sectionTitleClass } from '../../components/ui';
import { AccountStatus, CardList, accountLabel } from './accountDisplay';
import { useMe, type Me } from './useMe';

const AccountList = ({ me }: { readonly me: Me }) =>
  me.accounts.length === 0 ? (
    <Empty>You have no accounts yet.</Empty>
  ) : (
    <ul aria-label="Accounts" className="grid gap-4 md:grid-cols-2">
      {me.accounts.map((account) => (
        <li key={account.accountId} className={cx(cardClass, 'space-y-4 p-4 sm:p-5')}>
          <h3 className="text-base font-semibold tracking-tight">
            <Link
              to={routes.account(account.accountId)}
              className={cx('rounded-sm text-ink hover:text-accent motion-safe:transition-colors', focusRing)}
            >
              {accountLabel(account)}
            </Link>
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
      <PageHeader title={me.data ? `Hello, ${me.data.name}` : 'Your accounts'} />
      <div className="space-y-10">
        <section aria-labelledby={accountsHeading} className="space-y-4">
          <h2 id={accountsHeading} className={sectionTitleClass}>
            Accounts
          </h2>
          {me.isPending ? <Loading>Loading your accounts…</Loading> : null}
          {me.isError ? <LoadError message="We couldn't load your accounts." onRetry={() => void me.refetch()} /> : null}
          {me.data ? <AccountList me={me.data} /> : null}
        </section>
        <section aria-labelledby={recentHeading} className="space-y-4">
          <h2 id={recentHeading} className={sectionTitleClass}>
            Recent transactions
          </h2>
          <TransactionList filter={{}} caption="Recent transactions across all your accounts" />
        </section>
      </div>
    </>
  );
};
