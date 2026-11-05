-- Redundant with the PK, but a composite FK needs it to prove the viewed evidence belongs to the audited dispute.
alter table dispute_evidence add constraint dispute_evidence_id_dispute_id_key unique (id, dispute_id);

create table evidence_view (
  id bigint generated always as identity primary key,
  evidence_id bigint not null,
  dispute_id bigint not null references dispute (id) on delete restrict,
  agent_id uuid not null,
  viewed_at timestamptz not null default now(),
  constraint evidence_view_evidence_fkey foreign key (evidence_id, dispute_id)
    references dispute_evidence (id, dispute_id) on delete restrict
);

create index evidence_view_agent_rate_idx on evidence_view (agent_id, viewed_at);

-- Backstop to the grants: the audit trail of agent downloads cannot be rewritten by anyone, retention included (ADR-072).
create function evidence_view_guard() returns trigger
  language plpgsql security invoker set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'evidence_view is insert-only (% by %)', tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

revoke all on function evidence_view_guard() from public;

create trigger evidence_view_immutable before update or delete on evidence_view
  for each row execute function evidence_view_guard();

create trigger evidence_view_no_truncate before truncate on evidence_view
  for each statement execute function evidence_view_guard();
