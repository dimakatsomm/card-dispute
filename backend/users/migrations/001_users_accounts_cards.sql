create table app_user (
  id bigint generated always as identity primary key,
  user_id uuid not null unique default uuidv7(),
  auth_id uuid not null unique,
  name text not null,
  surname text not null,
  cellphone_number text check (cellphone_number ~ '^\+[1-9][0-9]{7,14}$'),
  email public.citext not null unique,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table account (
  id bigint generated always as identity primary key,
  account_id uuid not null unique default uuidv7(),
  user_id bigint not null references app_user (id) on delete restrict,
  -- Shape-locked so a full account number cannot be stored even by mistake.
  account_number_masked text not null check (account_number_masked ~ '^\*{4}[0-9]{4}$'),
  account_type text not null check (account_type in ('CHEQUE', 'SAVINGS', 'CREDIT')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'FROZEN', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index account_user_id_idx on account (user_id);

create table card (
  id bigint generated always as identity primary key,
  card_id uuid not null unique default uuidv7(),
  account_id bigint not null references account (id) on delete restrict,
  token text not null unique,
  last4 char(4) not null check (last4 ~ '^[0-9]{4}$'),
  expiry_month smallint not null check (expiry_month between 1 and 12),
  expiry_year smallint not null check (expiry_year between 2000 and 2100),
  brand text not null check (brand in ('VISA', 'MASTERCARD', 'AMEX')),
  card_type text not null check (card_type in ('DEBIT', 'CREDIT')),
  -- No EXPIRED: expiry is derived by isCardExpired() in dispute-domain only (PR-DB-4).
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'BLOCKED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index card_account_id_idx on card (account_id);

create trigger app_user_set_updated_at before update on app_user
  for each row execute function set_updated_at();
create trigger account_set_updated_at before update on account
  for each row execute function set_updated_at();
create trigger card_set_updated_at before update on card
  for each row execute function set_updated_at();

grant update (name, surname, cellphone_number, email, status) on app_user to users_app;
grant update (status) on account to users_app;
grant update (status) on card to users_app;
