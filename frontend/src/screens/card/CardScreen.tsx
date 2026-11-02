import { Link, useParams } from 'react-router';
import { routes } from '../../app/routes';
import { TransactionList } from '../../components/transactions/TransactionList';
import { PageHeader, linkClass } from '../../components/ui';
import { CardState, cardExpiry, cardLabel } from '../home/accountDisplay';
import { findCard, useMe } from '../home/useMe';

export const CardScreen = () => {
  const { cardId = '' } = useParams();
  const me = useMe();
  // The heading is cosmetic; the list is server-scoped by cardId, so it never waits on or fails with /me.
  const card = me.data ? findCard(me.data, cardId) : undefined;
  const title = card ? cardLabel(card) : 'Card';
  return (
    <>
      <PageHeader
        title={
          <>
            {title}
            {card ? <CardState card={card} /> : null}
          </>
        }
      >
        {card ? (
          <p className="tabular-nums">
            Expires {cardExpiry(card)} ·{' '}
            <Link to={routes.account(card.accountId)} className={linkClass}>
              View account
            </Link>
          </p>
        ) : null}
      </PageHeader>
      <TransactionList filter={{ cardId }} caption={`Transactions on ${title}`} />
    </>
  );
};
