create table transaction (
  id bigint generated always as identity primary key,
  transaction_id uuid not null unique default uuidv7(),
  user_id uuid not null,
  account_id uuid not null,
  card_id uuid not null,
  amount numeric(12, 2) not null check (amount > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  merchant_name text not null,
  mcc char(4) check (mcc ~ '^[0-9]{4}$'),
  type text not null check (type in ('PURCHASE', 'REFUND', 'ATM_WITHDRAWAL', 'FEE')),
  status text not null check (status in ('PENDING', 'POSTED', 'DECLINED', 'REVERSED')),
  transaction_at timestamptz not null,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The dispute window counts from posted_at, so a POSTED row must carry it (PR-DB-7).
  constraint transaction_posted_has_posted_at check (status <> 'POSTED' or posted_at is not null)
);

create trigger transaction_set_updated_at before update on transaction
  for each row execute function set_updated_at();

create index transaction_user_at_idx on transaction (user_id, transaction_at desc, transaction_id desc);
-- transaction_id tie-breaker matches the API cursor order; without it the planner prefers user_at_idx + filter.
create index transaction_user_card_at_idx on transaction (user_id, card_id, transaction_at desc, transaction_id desc);
create index transaction_user_account_at_idx on transaction (user_id, account_id, transaction_at desc, transaction_id desc);
