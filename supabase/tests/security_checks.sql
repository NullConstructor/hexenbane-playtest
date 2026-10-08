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

-- 5. Game telemetry, crash and feedback tables: as locked down as the application tables.
do $$
declare
  r text;
  t text;
  op text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach t in array array['telemetry_events', 'crash_reports', 'crash_signatures', 'feedback_reports',
                             'game_rate_limits', 'quarry_balance', 'card_stats', 'implement_pairs',
                             'death_causes', 'crash_summary'] loop
      foreach op in array array['select', 'insert', 'update', 'delete'] loop
        if has_table_privilege(r, 'public.' || t, op) then
          raise exception 'FAIL: % has % on %', r, op, t;
        end if;
      end loop;
    end loop;
    foreach t in array array['public.crash_signature_seen(text, text, boolean)',
                             'public.game_rate_limit_hit(text, text, integer, integer)',
                             'public.telemetry_num(jsonb, text)'] loop
      if has_function_privilege(r, t, 'execute') then
        raise exception 'FAIL: % can execute %', r, t;
      end if;
    end loop;
    foreach t in array array['telemetry_events_id_seq', 'crash_reports_id_seq', 'feedback_reports_id_seq'] loop
      if has_sequence_privilege(r, 'public.' || t, 'usage') then
        raise exception 'FAIL: % can use sequence %', r, t;
      end if;
    end loop;
  end loop;
  raise notice 'ok: anon and authenticated have no privileges on the game tables, views, functions or sequences';
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['telemetry_events', 'crash_reports', 'crash_signatures', 'feedback_reports', 'game_rate_limits'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL: row level security is not enabled on %', t;
    end if;
    if exists (select from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'FAIL: a policy exists on %; review it before going live', t;
    end if;
  end loop;
  foreach t in array array['quarry_balance', 'card_stats', 'implement_pairs', 'death_causes', 'crash_summary'] loop
    if not coalesce((select 'security_invoker=true' = any (reloptions) from pg_class where oid = ('public.' || t)::regclass), false) then
      raise exception 'FAIL: view % is not security_invoker', t;
    end if;
  end loop;
  raise notice 'ok: game tables have row level security and no policies; views are security_invoker';
end $$;

set local role anon;
do $$
begin
  perform 1 from public.telemetry_events limit 1;
  raise exception 'FAIL: anon could select telemetry';
exception when insufficient_privilege then
  raise notice 'ok: anon telemetry select refused';
end $$;
do $$
begin
  perform 1 from public.crash_summary limit 1;
  raise exception 'FAIL: anon could read crash_summary';
exception when insufficient_privilege then
  raise notice 'ok: anon view select refused';
end $$;
do $$
begin
  perform public.game_rate_limit_hit('x', 'x', 1, 60);
  raise exception 'FAIL: anon could call game_rate_limit_hit';
exception when insufficient_privilege then
  raise notice 'ok: anon rate-limit function refused';
end $$;
reset role;

-- 6. The service role (the game's Edge Functions) can do its job, within the rules.
set local role service_role;

-- A retried batch is not counted twice.
insert into public.telemetry_events (install_id, session_id, version, name, seq, occurred_at, data) values
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'hunt_start', 0, now(),
   '{"hunt_id":"chk-h1","coven":"chk-coven","implements":["nails","censer"]}'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'fight_end', 1, now(),
   '{"hunt_id":"chk-h1","quarry":"chk-quarry","night":1,"result":"win","beats":10,"vitality_start":30,"vitality_end":20,"mode":"hunt","cards_played":{"chk-card":2,"chk-bad":"x"}}'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'fight_end', 2, now(),
   '{"hunt_id":"chk-h1","quarry":"chk-quarry","night":1,"result":"loss","beats":"lots","vitality_start":20,"vitality_end":0,"mode":"hunt","cards_played":{"chk-card":1}}'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'fight_end', 3, now(),
   '{"quarry":"chk-quarry","night":1,"result":"loss","mode":"lab"}'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'card_offer', 4, now(),
   '{"hunt_id":"chk-h1","source":"fight","offered":["chk-card","chk-other","chk-card"],"taken":"chk-card"}'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'card_offer', 5, now(),
   '{"hunt_id":"chk-h1","source":"shop","offered":["chk-card"],"taken":null}'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'hunt_end', 6, now(),
   '{"hunt_id":"chk-h1","result":"lost","night":3,"killed_by":"chk-quarry"}');
insert into public.telemetry_events (install_id, session_id, version, name, seq, occurred_at, data) values
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'hunt_end', 6, now(), '{}')
on conflict (session_id, seq) do nothing;
do $$
begin
  if (select count(*) from public.telemetry_events where session_id = '22222222-2222-4222-8222-222222222222') <> 7 then
    raise exception 'FAIL: a duplicate (session_id, seq) was stored';
  end if;
  raise notice 'ok: (session_id, seq) is unique; retried events are skipped';
end $$;

do $$
begin
  insert into public.telemetry_events (install_id, session_id, version, name, seq, occurred_at, data)
  values (gen_random_uuid(), gen_random_uuid(), '0.8.0', 'drop_table', 0, now(), '{}');
  raise exception 'FAIL: unknown telemetry event accepted';
exception when check_violation then
  raise notice 'ok: telemetry event names are constrained';
end $$;

-- The views read the events above (and ignore the lab fight and non-numeric values).
do $$
declare
  rec record;
begin
  select * into rec from public.quarry_balance where quarry = 'chk-quarry' and night = 1;
  if rec.fights <> 2 or rec.wins <> 1 or rec.losses <> 1 or rec.win_rate <> 0.5 or rec.avg_beats <> 10
     or rec.avg_vitality_lost <> 15 then
    raise exception 'FAIL: quarry_balance gave %', row_to_json(rec);
  end if;

  select * into rec from public.card_stats where card_id = 'chk-card';
  if rec.offered <> 2 or rec.taken <> 1 or rec.pick_rate <> 0.5 or rec.fights_played_in <> 2
     or rec.times_played <> 3 or rec.win_rate_when_played <> 0.5 then
    raise exception 'FAIL: card_stats gave %', row_to_json(rec);
  end if;
  if exists (select from public.card_stats where card_id = 'chk-bad') then
    raise exception 'FAIL: card_stats counted a non-numeric play count';
  end if;

  select * into rec from public.implement_pairs where coven = 'chk-coven';
  if rec.implements <> 'censer + nails' or rec.hunts <> 1 or rec.wins <> 0 or rec.avg_night_reached <> 3 then
    raise exception 'FAIL: implement_pairs gave %', row_to_json(rec);
  end if;

  select * into rec from public.death_causes where killed_by = 'chk-quarry';
  if rec.deaths <> 1 or rec.night <> 3 then
    raise exception 'FAIL: death_causes gave %', row_to_json(rec);
  end if;
  raise notice 'ok: quarry_balance, card_stats, implement_pairs and death_causes';
end $$;

-- Crash signatures: counted every time, claimed for Discord once.
insert into public.crash_reports (report_id, install_id, session_id, version, kind, message, occurred_at, signature)
values
  ('CR-QQQQ22', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'crash', 'boom 1', now(), repeat('c', 64)),
  ('CR-QQQQ33', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '0.8.0', 'crash', 'boom 2', now(), repeat('c', 64));
do $$
declare
  first_hit record;
  second_hit record;
  unclaimed record;
begin
  select * into first_hit from public.crash_signature_seen(repeat('c', 64), '0.8.0', true);
  select * into second_hit from public.crash_signature_seen(repeat('c', 64), '0.8.0', true);
  if first_hit.seen <> 1 or not first_hit.notify or second_hit.seen <> 2 or second_hit.notify then
    raise exception 'FAIL: crash_signature_seen gave % then %', row_to_json(first_hit), row_to_json(second_hit);
  end if;
  select * into unclaimed from public.crash_signature_seen(repeat('d', 64), '0.8.0', false);
  if unclaimed.notify then raise exception 'FAIL: crash_signature_seen claimed without p_claim'; end if;
  if (select reports from public.crash_summary where signature = repeat('c', 64)) <> 2 then
    raise exception 'FAIL: crash_summary did not count both reports';
  end if;
  raise notice 'ok: crash signatures post once; crash_summary groups them';
end $$;

do $$
begin
  insert into public.crash_reports (report_id, install_id, session_id, version, kind, message, occurred_at, signature)
  values ('CR-QQQQ44', gen_random_uuid(), gen_random_uuid(), '0.8.0', 'panic', 'x', now(), repeat('c', 64));
  raise exception 'FAIL: unknown crash kind accepted';
exception when check_violation then
  raise notice 'ok: crash kinds are constrained';
end $$;

insert into public.feedback_reports (report_id, install_id, version, kind, title)
values ('BR-QQQQ22', '11111111-1111-4111-8111-111111111111', '0.8.0', 'UI', 'Check report');
do $$
begin
  insert into public.feedback_reports (report_id, install_id, version, kind, title)
  values ('BR-QQQQ33', gen_random_uuid(), '0.8.0', 'Rant', 'x');
  raise exception 'FAIL: unknown feedback kind accepted';
exception when check_violation then
  raise notice 'ok: feedback kinds are constrained';
end $$;
do $$
begin
  insert into public.feedback_reports (report_id, install_id, version, kind, title)
  values ('BR-QQQQ22', gen_random_uuid(), '0.8.0', 'Bug', 'x');
  raise exception 'FAIL: duplicate report id accepted';
exception when unique_violation then
  if sqlerrm not like '%feedback_reports_report_id_key%' then raise; end if;
  raise notice 'ok: report ids are unique';
end $$;

-- Rate limits: the third hit of a limit-2 window is refused.
do $$
declare
  a record;
  b record;
  c record;
begin
  select * into a from public.game_rate_limit_hit('check', 'subject', 2, 600);
  select * into b from public.game_rate_limit_hit('check', 'subject', 2, 600);
  select * into c from public.game_rate_limit_hit('check', 'subject', 2, 600);
  if not a.allowed or not b.allowed or c.allowed or c.retry_after not between 1 and 600 then
    raise exception 'FAIL: rate limit gave %, %, %', row_to_json(a), row_to_json(b), row_to_json(c);
  end if;
  raise notice 'ok: rate limit refuses past the limit';
end $$;

reset role;

do $$ begin raise notice 'ALL DATABASE CHECKS PASSED'; end $$;

rollback;
