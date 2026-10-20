import { Link, useParams } from 'react-router';
import { routes } from '../../app/routes';
import { TransactionList } from '../../components/transactions/TransactionList';
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
      <h1>
        {title}
        {card ? <CardState card={card} /> : null}
      </h1>
      {card ? (
        <p>
          Expires {cardExpiry(card)} · <Link to={routes.account(card.accountId)}>View account</Link>
        </p>
      ) : null}
      <TransactionList filter={{ cardId }} caption={`Transactions on ${title}`} />
    </>
  );
};
