create table dispute_status_history (
  id bigint generated always as identity primary key,
  dispute_id bigint not null references dispute (id) on delete restrict,
  action text not null check (action in (
    'CREATE', 'EDIT', 'EVIDENCE_ADDED', 'EVIDENCE_REJECTED', 'REVIEW', 'RESOLVE', 'WITHDRAW')),
  from_status text check (from_status in (
    'SUBMITTED', 'UNDER_REVIEW', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'WITHDRAWN')),
  to_status text not null check (to_status in (
    'SUBMITTED', 'UNDER_REVIEW', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'WITHDRAWN')),
  actor_type text not null check (actor_type in ('USER', 'SYSTEM_RULE', 'AGENT')),
  actor_id text not null,
  note text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now(),
  constraint dispute_status_history_from_status_null_on_create check ((action = 'CREATE') = (from_status is null))
);

create index dispute_status_history_dispute_id_idx on dispute_status_history (dispute_id);

-- Backstop to the grants: even the owner cannot rewrite history; only retention may scrub its granted columns.
create function dispute_status_history_guard() returns trigger
  language plpgsql security invoker set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and current_user = 'disputes_retention' then
    return new;
  end if;
  raise exception 'dispute_status_history is insert-only (% by %)', tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

revoke all on function dispute_status_history_guard() from public;

create trigger dispute_status_history_immutable before update or delete on dispute_status_history
  for each row execute function dispute_status_history_guard();

create trigger dispute_status_history_no_truncate before truncate on dispute_status_history
  for each statement execute function dispute_status_history_guard();

grant select on dispute_status_history to disputes_retention;
grant update (note, before, after) on dispute_status_history to disputes_retention;
