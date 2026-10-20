-- Erasure must not reorder the customer's dispute list (docs/03 Retention); retention can update only the erased text columns.
create or replace trigger dispute_set_updated_at before update on dispute
  for each row when (current_user <> 'disputes_retention') execute function set_updated_at();

create or replace function dispute_evidence_status_guard() returns trigger
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
  if new.file_name is distinct from old.file_name and (new.file_name <> '[erased]' or new.status <> 'ERASED') then
    raise exception 'file_name may only be replaced by the erasure tombstone on ERASED evidence'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

grant update (file_name) on dispute_evidence to disputes_retention;

alter table dispute_evidence drop constraint dispute_evidence_rejection_reason_check;
alter table dispute_evidence add constraint dispute_evidence_rejection_reason_check
  check (rejection_reason in ('MALWARE', 'TYPE_MISMATCH', 'CHECKSUM', 'SIZE', 'SCAN_FAILED'));

-- Sweeper candidate sets; partial so they hold only rows still awaiting expiry/erasure (plan test proved seq scans without them).
create index dispute_evidence_pending_age_idx on dispute_evidence (created_at) where status = 'PENDING';
create index dispute_resolved_unerased_idx on dispute (resolved_at)
  where status in ('RESOLVED_ACCEPTED', 'RESOLVED_REJECTED') and description <> '[erased]';
create index dispute_status_history_withdraw_idx on dispute_status_history (created_at, dispute_id)
  where action = 'WITHDRAW';
