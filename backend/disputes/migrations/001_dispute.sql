create table dispute (
  id bigint generated always as identity primary key,
  dispute_id uuid not null unique default uuidv7(),
  -- Plain (not partial) unique: one dispute per transaction ever, incl. WITHDRAWN (ADR-020); also the retry guard (ADR-023).
  transaction_id uuid not null unique,
  user_id uuid not null,
  reason_code text not null check (reason_code in (
    'FRAUD', 'NOT_RECEIVED', 'DUPLICATE', 'INCORRECT_AMOUNT', 'CANCELLED_SUBSCRIPTION', 'DEFECTIVE_GOODS', 'OTHER')),
  -- '[erased]' is the retention sweeper's tombstone (docs/03 Retention); it is shorter than the input minimum.
  description text not null check (char_length(description) between 10 and 2000 or description = '[erased]'),
  status text not null check (status in (
    'SUBMITTED', 'UNDER_REVIEW', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'WITHDRAWN')),
  version int not null default 1 check (version >= 1),
  resolved_at timestamptz,
  resolution_note text,
  created_by text not null check (created_by ~ '^(USER|SYSTEM_RULE|AGENT):.+$'),
  updated_by text not null check (updated_by ~ '^(USER|SYSTEM_RULE|AGENT):.+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispute_resolved_at_matches_status
    check ((status in ('RESOLVED_ACCEPTED', 'RESOLVED_REJECTED')) = (resolved_at is not null))
);

create index dispute_user_paging_idx on dispute (user_id, updated_at desc, dispute_id desc);
create index dispute_status_queue_idx on dispute (status, created_at);

create trigger dispute_set_updated_at before update on dispute
  for each row execute function set_updated_at();

grant update (status, reason_code, description, version, resolved_at, resolution_note, updated_by)
  on dispute to disputes_app;

grant select on dispute to disputes_retention;
grant update (description, resolution_note) on dispute to disputes_retention;
