import { useId } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '../../app/routes';
import { LoadError } from '../../components/transactions/LoadError';
import { TransactionList } from '../../components/transactions/TransactionList';
import { Loading, PageHeader, linkClass, sectionTitleClass } from '../../components/ui';
import { AccountStatus, CardList, accountLabel } from '../home/accountDisplay';
import { findAccount, useMe } from '../home/useMe';

export const AccountScreen = () => {
  const { accountId = '' } = useParams();
  const me = useMe();
  const cardsHeading = useId();
  const transactionsHeading = useId();

  if (me.isPending) return <Loading>Loading account…</Loading>;
  if (me.isError) return <LoadError message="We couldn't load this account." onRetry={() => void me.refetch()} />;

  const account = findAccount(me.data, accountId);
  if (!account) {
    return (
      <PageHeader title="Account not found">
        <p>
          <Link to={routes.home()} className={linkClass}>
            Back to your accounts
          </Link>
        </p>
      </PageHeader>
    );
  }

  const label = accountLabel(account);
  return (
    <>
      <PageHeader
        title={
          <>
            {label}
            <AccountStatus account={account} />
          </>
        }
      />
      <div className="space-y-10">
        <section aria-labelledby={cardsHeading} className="space-y-4">
          <h2 id={cardsHeading} className={sectionTitleClass}>
            Cards
          </h2>
          <div className="max-w-2xl">
            <CardList cards={account.cards} label={`Cards on ${label}`} />
          </div>
        </section>
        <section aria-labelledby={transactionsHeading} className="space-y-4">
          <h2 id={transactionsHeading} className={sectionTitleClass}>
            Transactions
          </h2>
          <TransactionList filter={{ accountId: account.accountId }} caption={`Transactions on ${label}`} />
        </section>
      </div>
    </>
  );
};
