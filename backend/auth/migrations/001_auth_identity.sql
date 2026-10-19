create table auth_identity (
  id bigint generated always as identity primary key,
  auth_id uuid not null unique default uuidv7(),
  cognito_sub text not null unique check (cognito_sub <> ''),
  -- Lower-cased at write so uniqueness is case-insensitive without citext.
  username text not null unique check (username <> '' and username = lower(username)),
  user_id uuid not null unique,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger auth_identity_set_updated_at before update on auth_identity
  for each row execute function set_updated_at();

-- Offboarding flips status only; identity columns are written once at provisioning.
grant update (status) on auth_identity to auth_app;
