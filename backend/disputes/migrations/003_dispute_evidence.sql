create table dispute_evidence (
  id bigint generated always as identity primary key,
  evidence_id uuid not null unique default uuidv7(),
  dispute_id bigint not null references dispute (id) on delete restrict,
  file_name text not null check (char_length(file_name) between 1 and 255),
  declared_content_type text not null check (declared_content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  declared_size_bytes int not null check (declared_size_bytes between 1 and 10485760),
  declared_sha256 char(64) not null check (declared_sha256 ~ '^[0-9a-f]{64}$'),
  s3_key text check (s3_key is null or s3_key like 'evidence/%'),
  status text not null check (status in ('PENDING', 'STORED', 'REJECTED', 'EXPIRED', 'ERASED')),
  rejection_reason text check (rejection_reason in ('MALWARE', 'TYPE_MISMATCH', 'CHECKSUM', 'SIZE')),
  stored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispute_evidence_s3_key_only_when_stored check ((status = 'STORED') = (s3_key is not null)),
  constraint dispute_evidence_rejection_reason_only_when_rejected
    check ((status = 'REJECTED') = (rejection_reason is not null))
);

create index dispute_evidence_dispute_id_idx on dispute_evidence (dispute_id);

create trigger dispute_evidence_set_updated_at before update on dispute_evidence
  for each row execute function set_updated_at();

-- Only retention may erase and nobody may revive; erasure clears key/reason itself because retention may UPDATE only status.
create function dispute_evidence_status_guard() returns trigger
  language plpgsql security invoker set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    if old.status = 'ERASED' then
      raise exception 'erased evidence cannot change status' using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'ERASED' then
      if current_user <> 'disputes_retention' then
        raise exception 'only disputes_retention may erase evidence' using errcode = 'insufficient_privilege';
      end if;
      new.s3_key := null;
      new.rejection_reason := null;
    end if;
  end if;
  return new;
end
$$;

revoke all on function dispute_evidence_status_guard() from public;

create trigger dispute_evidence_status_guard before update on dispute_evidence
  for each row execute function dispute_evidence_status_guard();

grant update (status, s3_key, rejection_reason, stored_at) on dispute_evidence to disputes_app;

grant select on dispute_evidence to disputes_retention;
grant update (status) on dispute_evidence to disputes_retention;
