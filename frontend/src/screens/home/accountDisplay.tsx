import { Link } from 'react-router';
import { routes } from '../../app/routes';
import { Badge, cx, linkClass, listClass, mutedClass } from '../../components/ui';
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
  account.status === 'ACTIVE' ? null : (
    <span className="font-normal text-muted">{` (${accountStatusLabels[account.status]})`}</span>
  );

// The badge is visual only; screen readers keep the "(Expired)" wording.
const ExpiredBadge = () => (
  <strong className="font-medium">
    <Badge tone="danger" aria-hidden="true" className="ml-1.5 align-middle max-sm:px-1.5 max-sm:text-[0.6875rem]">
      Expired
    </Badge>
    <span className="sr-only">(Expired)</span>
  </strong>
);

export const CardState = ({ card }: { readonly card: Card }) => (
  <>
    {card.expired ? (
      <>
        {' '}
        <ExpiredBadge />
      </>
    ) : null}
    {card.status === 'ACTIVE' ? null : (
      <span className="font-normal text-muted">{` (${cardStatusLabels[card.status]})`}</span>
    )}
  </>
);

export const CardList = ({ cards, label }: { readonly cards: Account['cards']; readonly label: string }) =>
  cards.length === 0 ? (
    <p className={mutedClass}>No cards on this account.</p>
  ) : (
    <ul aria-label={label} className={listClass}>
      {cards.map((card) => (
        <li
          key={card.cardId}
          className="flex flex-col gap-0.5 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        >
          <Link to={routes.card(card.cardId)} className={cx(linkClass, 'font-medium')}>
            {cardLabel(card)}
            <CardState card={card} />
          </Link>{' '}
          <span className="shrink-0 text-xs text-muted tabular-nums">Expires {cardExpiry(card)}</span>
        </li>
      ))}
    </ul>
  );
