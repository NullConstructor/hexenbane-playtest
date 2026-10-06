-- Hexenbane playtest database checks. Safe to run against any database that has the
-- migration applied (local or hosted): everything happens in one transaction that is rolled
-- back at the end. Any failed check raises an error naming it.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/security_checks.sql
--   (or paste it into the Supabase SQL Editor)

begin;

-- 1. The public API roles cannot read or write anything.
do $$
declare
  r text;
  t text;
  op text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach t in array array['playtest_applications', 'playtest_agreement_versions'] loop
      foreach op in array array['select', 'insert', 'update', 'delete'] loop
        if has_table_privilege(r, 'public.' || t, op) then
          raise exception 'FAIL: % has % on %', r, op, t;
        end if;
      end loop;
    end loop;
  end loop;
  raise notice 'ok: anon and authenticated have no privileges on the playtest tables';
end $$;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.playtest_applications'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.playtest_agreement_versions'::regclass) then
    raise exception 'FAIL: row level security is not enabled';
  end if;
  if exists (select from pg_policies where schemaname = 'public' and tablename like 'playtest_%') then
    raise exception 'FAIL: a policy exists on a playtest table; review it before going live';
  end if;
  raise notice 'ok: row level security on, no policies';
end $$;

-- 2. Acting as anon really is refused (not just "no rows").
set local role anon;
do $$
begin
  perform 1 from public.playtest_applications limit 1;
  raise exception 'FAIL: anon could select applications';
exception when insufficient_privilege then
  raise notice 'ok: anon select refused';
end $$;
do $$
begin
  insert into public.playtest_applications (public_application_id) values ('HEX-PT-AAAAAA');
  raise exception 'FAIL: anon could insert an application';
exception when insufficient_privilege then
  raise notice 'ok: anon insert refused';
end $$;
reset role;

-- 3. The service role (the Edge Function) can do its job, within the rules.
set local role service_role;

insert into public.playtest_agreement_versions (version, sha256, body)
values ('HEXENBANE-PLAYTEST-1999-01-v1', repeat('a', 64), 'test agreement')
on conflict (version) do nothing;

insert into public.playtest_applications (
  public_application_id, preferred_name, discord_username, interest_reason, similar_games,
  testing_experience, cpu, gpu, ram, operating_system, joined_discord, agreement_accepted,
  agreement_version, agreement_hash, agreement_accepted_at
) values (
  'HEX-PT-QQQQ22', 'Test Hunter', '@Test.Hunter', 'Checks only', 'Slay the Spire', 'Some',
  'CPU', 'GPU', '16 GB', 'Windows 11', true, true,
  'HEXENBANE-PLAYTEST-1999-01-v1', repeat('a', 64), now()
);

do $$
declare
  n text;
begin
  select discord_username_normalized into n from public.playtest_applications where public_application_id = 'HEX-PT-QQQQ22';
  if n is distinct from 'test.hunter' then raise exception 'FAIL: normalized username was %', n; end if;
  raise notice 'ok: discord username normalized (original kept)';
end $$;

-- duplicate open application for the same username, different case and spacing
do $$
begin
  insert into public.playtest_applications (
    public_application_id, preferred_name, discord_username, interest_reason, similar_games,
    testing_experience, cpu, gpu, ram, operating_system, joined_discord, agreement_accepted,
    agreement_version, agreement_hash, agreement_accepted_at
  ) values (
    'HEX-PT-QQQQ33', 'Again', '  test.HUNTER ', 'Checks only', 'x', 'x', 'x', 'x', 'x', 'x',
    true, true, 'HEXENBANE-PLAYTEST-1999-01-v1', repeat('a', 64), now()
  );
  raise exception 'FAIL: duplicate open application accepted';
exception when unique_violation then
  if sqlerrm not like '%playtest_applications_active_discord_username_key%' then raise; end if;
  raise notice 'ok: duplicate open application refused';
end $$;

-- agreement hash must match the recorded version
do $$
begin
  insert into public.playtest_applications (
    public_application_id, preferred_name, discord_username, interest_reason, similar_games,
    testing_experience, cpu, gpu, ram, operating_system, joined_discord, agreement_accepted,
    agreement_version, agreement_hash, agreement_accepted_at
  ) values (
    'HEX-PT-QQQQ44', 'Forger', 'forger', 'x', 'x', 'x', 'x', 'x', 'x', 'x',
    true, true, 'HEXENBANE-PLAYTEST-1999-01-v1', repeat('b', 64), now()
  );
  raise exception 'FAIL: application with an unknown agreement hash accepted';
exception when foreign_key_violation then
  raise notice 'ok: agreement version and hash must match a recorded agreement';
end $$;

-- agreement and discord membership must be true
do $$
begin
  insert into public.playtest_applications (
    public_application_id, preferred_name, discord_username, interest_reason, similar_games,
    testing_experience, cpu, gpu, ram, operating_system, joined_discord, agreement_accepted,
    agreement_version, agreement_hash, agreement_accepted_at
  ) values (
    'HEX-PT-QQQQ66', 'NoAgree', 'noagree', 'x', 'x', 'x', 'x', 'x', 'x', 'x',
    true, false, 'HEXENBANE-PLAYTEST-1999-01-v1', repeat('a', 64), now()
  );
  raise exception 'FAIL: application without agreement accepted';
exception when check_violation then
  raise notice 'ok: agreement_accepted must be true';
end $$;

-- status is constrained
do $$
begin
  update public.playtest_applications set status = 'maybe' where public_application_id = 'HEX-PT-QQQQ22';
  raise exception 'FAIL: unknown status accepted';
exception when check_violation then
  raise notice 'ok: status limited to pending/contacted/approved/rejected/withdrawn';
end $$;

-- agreement evidence is frozen
do $$
begin
  update public.playtest_applications set agreement_accepted_at = now() - interval '1 day' where public_application_id = 'HEX-PT-QQQQ22';
  raise exception 'FAIL: agreement evidence could be edited';
exception when restrict_violation then
  raise notice 'ok: agreement evidence cannot be edited';
end $$;

-- review timestamps fill themselves
update public.playtest_applications set status = 'contacted' where public_application_id = 'HEX-PT-QQQQ22';
update public.playtest_applications set status = 'approved' where public_application_id = 'HEX-PT-QQQQ22';
do $$
declare
  rec record;
begin
  select contacted_at, reviewed_at, updated_at, created_at into rec from public.playtest_applications where public_application_id = 'HEX-PT-QQQQ22';
  if rec.contacted_at is null or rec.reviewed_at is null then raise exception 'FAIL: review timestamps not filled'; end if;
  raise notice 'ok: contacted_at and reviewed_at filled on status change';
end $$;

-- a rejected applicant can apply again
update public.playtest_applications set status = 'rejected' where public_application_id = 'HEX-PT-QQQQ22';
insert into public.playtest_applications (
  public_application_id, preferred_name, discord_username, interest_reason, similar_games,
  testing_experience, cpu, gpu, ram, operating_system, joined_discord, agreement_accepted,
  agreement_version, agreement_hash, agreement_accepted_at
) values (
  'HEX-PT-QQQQ77', 'Second try', 'test.hunter', 'x', 'x', 'x', 'x', 'x', 'x', 'x',
  true, true, 'HEXENBANE-PLAYTEST-1999-01-v1', repeat('a', 64), now()
);
do $$ begin raise notice 'ok: rejected applicant may reapply'; end $$;

reset role;

-- 4. Published agreement versions are permanent, even for the database owner.
do $$
begin
  update public.playtest_agreement_versions set body = 'changed' where version = 'HEXENBANE-PLAYTEST-1999-01-v1';
  raise exception 'FAIL: agreement text could be changed';
exception when restrict_violation then
  raise notice 'ok: agreement versions cannot be updated';
end $$;
do $$
begin
  delete from public.playtest_agreement_versions where version = 'HEXENBANE-PLAYTEST-1999-01-v1';
  raise exception 'FAIL: agreement version could be deleted';
exception when restrict_violation then
  raise notice 'ok: agreement versions cannot be deleted';
end $$;

do $$ begin raise notice 'ALL DATABASE CHECKS PASSED'; end $$;

rollback;
