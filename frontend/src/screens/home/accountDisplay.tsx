import { Link } from 'react-router';
import { routes } from '../../app/routes';
import type { Account, Card } from './useMe';

const accountTypeLabels: Readonly<Record<Account['accountType'], string>> = {
  CHEQUE: 'Cheque account',
  SAVINGS: 'Savings account',
  CREDIT: 'Credit account',
};

const accountStatusLabels: Readonly<Record<Account['status'], string>> = {
  ACTIVE: 'Active',
  FROZEN: 'Frozen',
  CLOSED: 'Closed',
};

const brandLabels: Readonly<Record<Card['brand'], string>> = {
  VISA: 'Visa',
  MASTERCARD: 'Mastercard',
  AMEX: 'American Express',
};

const cardTypeLabels: Readonly<Record<Card['cardType'], string>> = { DEBIT: 'debit', CREDIT: 'credit' };

const cardStatusLabels: Readonly<Record<Card['status'], string>> = {
  ACTIVE: 'Active',
  BLOCKED: 'Blocked',
  CANCELLED: 'Cancelled',
};

export const accountLabel = (account: Account): string =>
  `${accountTypeLabels[account.accountType]} ${account.accountNumberMasked}`;

export const cardLabel = (card: Card): string =>
  `${brandLabels[card.brand]} ${cardTypeLabels[card.cardType]} card ending ${card.last4}`;

export const cardExpiry = (card: Card): string => `${String(card.expiryMonth).padStart(2, '0')}/${card.expiryYear}`;

export const AccountStatus = ({ account }: { readonly account: Account }) =>
  account.status === 'ACTIVE' ? null : <>{` (${accountStatusLabels[account.status]})`}</>;

export const CardState = ({ card }: { readonly card: Card }) => (
  <>
    {card.expired ? (
      <>
        {' '}
        <strong>(Expired)</strong>
      </>
    ) : null}
    {card.status === 'ACTIVE' ? null : ` (${cardStatusLabels[card.status]})`}
  </>
);

export const CardList = ({ cards, label }: { readonly cards: Account['cards']; readonly label: string }) =>
  cards.length === 0 ? (
    <p>No cards on this account.</p>
  ) : (
    <ul aria-label={label}>
      {cards.map((card) => (
        <li key={card.cardId}>
          <Link to={routes.card(card.cardId)}>
            {cardLabel(card)}
            <CardState card={card} />
          </Link>{' '}
          <span>Expires {cardExpiry(card)}</span>
        </li>
      ))}
    </ul>
  );
