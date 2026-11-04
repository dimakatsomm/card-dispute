create table agent_identity (
  agent_id uuid primary key default uuidv7(),
  cognito_sub text not null unique check (cognito_sub <> ''),
  -- Rendered as the actor on timelines, so whitespace-only counts as missing.
  display_name text not null check (char_length(display_name) between 1 and 80 and btrim(display_name) <> ''),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger agent_identity_set_updated_at before update on agent_identity
  for each row execute function set_updated_at();

-- Agents are provisioned and offboarded out of band (ADR-071); the service only reads the access switch, so drop the schema default INSERT.
revoke all on agent_identity from auth_app;
grant select on agent_identity to auth_app;
