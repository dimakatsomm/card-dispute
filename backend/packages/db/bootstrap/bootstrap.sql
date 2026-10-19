-- Run by bootstrap.ts with the master connection; SCRAM verifiers arrive as cd_bootstrap.verifier_<role> settings.
select pg_advisory_xact_lock(hashtext('cd:bootstrap'));

create extension if not exists citext schema public;

revoke create on schema public from public;

create or replace function pg_temp.ensure_login_role(role_name text) returns void
language plpgsql as $$
declare
  verifier text := current_setting('cd_bootstrap.verifier_' || role_name, true);
  r pg_roles%rowtype;
begin
  if coalesce(verifier, '') not like 'SCRAM-SHA-256$%' then
    raise exception 'no SCRAM verifier supplied for role %', role_name;
  end if;
  select * into r from pg_roles where rolname = role_name;
  if not found then
    execute format(
      'create role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L',
      role_name, verifier);
    return;
  end if;
  -- PG16+ rejects naming these attributes at all unless the caller holds them, so only clear what is set; failure aborts.
  execute format('alter role %I with login nocreaterole %s %s %s %s password %L',
    role_name,
    case when r.rolsuper then 'nosuperuser' else '' end,
    case when r.rolcreatedb then 'nocreatedb' else '' end,
    case when r.rolreplication then 'noreplication' else '' end,
    case when r.rolbypassrls then 'nobypassrls' else '' end,
    verifier);
end $$;

do $bootstrap$
declare
  svc text;
  migrator text;
  app text;
begin
  execute format('revoke temp on database %I from public', current_database());

  foreach svc in array array['auth', 'users', 'transactions', 'disputes'] loop
    migrator := svc || '_migrator';
    app := svc || '_app';

    perform pg_temp.ensure_login_role(migrator);
    perform pg_temp.ensure_login_role(app);

    -- citext lives in public; without it on the path its operators silently fall back to case-sensitive text ones.
    execute format('alter role %I set search_path = %I, public', migrator, svc);
    execute format('alter role %I set search_path = %I, public', app, svc);

    -- Aurora's master is not a superuser: it needs SET on the migrator to hand it the schema and act as owner.
    execute format('grant %I to %I with set true, inherit false', migrator, current_user);

    execute format('create schema if not exists %I authorization %I', svc, migrator);
    if (select nspowner::regrole::text from pg_namespace where nspname = svc) <> quote_ident(migrator) then
      execute format('alter schema %I owner to %I', svc, migrator);
    end if;

    execute format('set local role %I', migrator);
    execute format('revoke all on schema %I from public', svc);
    execute format('grant usage on schema %I to %I', svc, app);
    -- Fail closed: no DELETE ever, and UPDATE is granted per table (column-level where sensible) by each migration.
    execute format(
      'alter default privileges for role %I in schema %I grant select, insert on tables to %I',
      migrator, svc, app);
    execute format(
      'alter default privileges for role %I in schema %I grant usage on sequences to %I',
      migrator, svc, app);
    -- Not IN SCHEMA: per-schema defaults can only add to the global PUBLIC EXECUTE grant, never remove it.
    execute format('alter default privileges for role %I revoke execute on functions from public', migrator);
    execute format(
      $fn$create or replace function %I.set_updated_at() returns trigger
          language plpgsql set search_path = pg_catalog, pg_temp
          as $body$ begin new.updated_at := now(); return new; end $body$$fn$,
      svc);
    execute format('revoke all on function %I.set_updated_at() from public', svc);
    reset role;
  end loop;

  perform pg_temp.ensure_login_role('disputes_retention');
  -- Schema USAGE only; its column-scoped UPDATE grants are added by the disputes migrations (D-04).
  set local role disputes_migrator;
  grant usage on schema disputes to disputes_retention;
  reset role;
end
$bootstrap$;
