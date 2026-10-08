-- Hexenbane playtest: telemetry, crash reports and the in-game (F8) report form.
--
-- Tables (written only by the Edge Functions, through the service role):
--   telemetry_events   gameplay events from ingest-telemetry; (session_id, seq) is unique so a
--                      retried batch is never counted twice
--   crash_reports      every crash / script error from submit-crash
--   crash_signatures   one row per distinct crash (per version): how often it was seen and
--                      whether #bug-reports has been told
--   feedback_reports   every F8 report from submit-feedback (no screenshot or log bytes)
--   game_rate_limits   request counters per install and per salted IP hash (never a raw IP)
--
-- Views for the Supabase SQL Editor (security_invoker, not readable by the public keys):
--   quarry_balance, card_stats, implement_pairs, death_causes, crash_summary
--
-- As with the application tables: row level security on, no policies, and no privileges for
-- anon / authenticated, so the public API keys can neither read nor write any of this.

-- ---------------------------------------------------------------------------------------------
-- Telemetry
-- ---------------------------------------------------------------------------------------------

create table public.telemetry_events (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  install_id uuid not null,
  session_id uuid not null,
  version text not null check (char_length(version) between 1 and 32),
  name text not null
    constraint telemetry_events_name_check
    check (name in ('session_start', 'session_end', 'hunt_start', 'fight_end', 'card_offer', 'boss_reward',
                    'purchase', 'inscription_cut', 'scene_lead', 'hunt_end', 'feedback_sent')),
  seq integer not null check (seq >= 0),
  occurred_at timestamptz not null,
  data jsonb not null default '{}'::jsonb
    constraint telemetry_events_data_object check (jsonb_typeof(data) = 'object'),
  constraint telemetry_events_session_seq_key unique (session_id, seq)
);

comment on table public.telemetry_events is
  'Gameplay events from the Hexenbane game (ingest-telemetry). install_id is a random per-install id, not a person; no IP addresses are stored.';
comment on column public.telemetry_events.seq is 'Per-session event counter from the game. (session_id, seq) is unique: retried batches are skipped.';
comment on column public.telemetry_events.occurred_at is 'When the event happened, by the player''s clock (UTC).';
comment on column public.telemetry_events.received_at is 'When the server stored it.';

create index telemetry_events_name_occurred_at_idx on public.telemetry_events (name, occurred_at);
create index telemetry_events_install_id_idx on public.telemetry_events (install_id);
create index telemetry_events_version_idx on public.telemetry_events (version);

-- ---------------------------------------------------------------------------------------------
-- Crash reports
-- ---------------------------------------------------------------------------------------------

create table public.crash_reports (
  id bigserial primary key,
  report_id text not null
    constraint crash_reports_report_id_key unique
    constraint crash_reports_report_id_format check (report_id ~ '^CR-[2346789ABCDEFGHJKMNPQRTWXYZ]{6}$'),
  received_at timestamptz not null default now(),
  install_id uuid not null,
  session_id uuid not null,
  version text not null check (char_length(version) between 1 and 32),
  kind text not null constraint crash_reports_kind_check check (kind in ('crash', 'error')),
  message text not null check (char_length(message) between 1 and 2000),
  stack text not null default '' check (char_length(stack) <= 8000),
  log_tail text not null default '' check (octet_length(log_tail) <= 65536),
  occurred_at timestamptz not null,
  context jsonb not null default '{}'::jsonb
    constraint crash_reports_context_object check (jsonb_typeof(context) = 'object'),
  signature text not null constraint crash_reports_signature_format check (signature ~ '^[0-9a-f]{64}$')
);

comment on table public.crash_reports is
  'Crashes and script errors from the game (submit-crash). Grouped by signature in the crash_summary view.';
comment on column public.crash_reports.signature is
  'SHA-256 of version, kind, the message without digits, and the first stack line. Same signature = same crash.';
comment on column public.crash_reports.session_id is 'The game session that crashed; matches telemetry_events.session_id.';

create index crash_reports_signature_idx on public.crash_reports (signature);
create index crash_reports_received_at_idx on public.crash_reports (received_at desc);

create table public.crash_signatures (
  signature text primary key constraint crash_signatures_signature_format check (signature ~ '^[0-9a-f]{64}$'),
  version text not null check (char_length(version) between 1 and 32),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1 check (seen_count >= 1),
  -- Set while a function is posting this crash to #bug-reports (stops two posts at once).
  discord_attempted_at timestamptz,
  -- Set once #bug-reports has the post. Later reports of the same crash are only counted.
  discord_posted_at timestamptz
);

comment on table public.crash_signatures is
  'One row per distinct crash. Only the first report of a signature is posted to #bug-reports; the rest are counted here.';

-- Counts one report of a crash and says whether the caller should post it to Discord. A post is
-- claimed only while none has succeeded and no other request claimed it in the last 15 minutes,
-- so a crash is posted once, and a failed post is retried by a later report.
create function public.crash_signature_seen(p_signature text, p_version text, p_claim boolean)
returns table (seen integer, notify boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_seen integer;
  v_claimed text;
begin
  insert into public.crash_signatures as s (signature, version)
  values (p_signature, p_version)
  on conflict (signature) do update
    set seen_count = s.seen_count + 1, last_seen_at = now()
  returning s.seen_count into v_seen;

  if p_claim then
    update public.crash_signatures as s
       set discord_attempted_at = now()
     where s.signature = p_signature
       and s.discord_posted_at is null
       and (s.discord_attempted_at is null or s.discord_attempted_at < now() - interval '15 minutes')
    returning s.signature into v_claimed;
  end if;

  return query select v_seen, v_claimed is not null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- In-game reports (F8)
-- ---------------------------------------------------------------------------------------------

create table public.feedback_reports (
  id bigserial primary key,
  report_id text not null
    constraint feedback_reports_report_id_key unique
    constraint feedback_reports_report_id_format check (report_id ~ '^BR-[2346789ABCDEFGHJKMNPQRTWXYZ]{6}$'),
  received_at timestamptz not null default now(),
  install_id uuid not null,
  version text not null check (char_length(version) between 1 and 32),
  kind text not null constraint feedback_reports_kind_check check (kind in ('Bug', 'Crash', 'Balance', 'UI', 'Other')),
  title text not null check (char_length(title) between 1 and 90),
  details text not null default '' check (char_length(details) <= 4000),
  context jsonb not null default '{}'::jsonb
    constraint feedback_reports_context_object check (jsonb_typeof(context) = 'object'),
  has_screenshot boolean not null default false,
  has_log boolean not null default false,
  -- True once the #bug-reports post was created. False rows never reached Discord (the player
  -- was told); read them here.
  discord_ok boolean not null default false,
  discord_posted_at timestamptz
);

comment on table public.feedback_reports is
  'Reports from the game''s F8 form (submit-feedback). The screenshot and log go only to the #bug-reports post, not here.';
comment on column public.feedback_reports.report_id is 'The ID shown in the forum post footer, e.g. BR-7KQ3XM.';

create index feedback_reports_received_at_idx on public.feedback_reports (received_at desc);
create index feedback_reports_not_posted_idx on public.feedback_reports (received_at) where not discord_ok;

-- ---------------------------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------------------------

create table public.game_rate_limits (
  bucket text not null check (char_length(bucket) between 1 and 64),
  -- An install id, or a salted SHA-256 of an IP address. Never a raw IP.
  subject text not null check (char_length(subject) between 1 and 128),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, subject, window_start)
);

comment on table public.game_rate_limits is
  'Fixed-window request counters for the game endpoints. Subjects are install ids or salted IP hashes. Old windows are cleared automatically.';

-- Counts one request and says whether it is within `p_limit` per `p_window_seconds`.
create function public.game_rate_limit_hit(p_bucket text, p_subject text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, retry_after integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit' using errcode = 'invalid_parameter_value';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.game_rate_limits as r (bucket, subject, window_start, hits)
  values (p_bucket, p_subject, v_window, 1)
  on conflict (bucket, subject, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;

  -- Housekeeping: now and then, forget windows that ended more than a day ago.
  if random() < 0.01 then
    delete from public.game_rate_limits where window_start < now() - interval '2 days';
  end if;

  return query select
    v_hits <= p_limit,
    greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Views for the SQL Editor
-- ---------------------------------------------------------------------------------------------
-- Event data is whatever the game sent, so numbers are read with telemetry_num(), which yields
-- null instead of failing the whole query when a value is missing or not a number.

create function public.telemetry_num(doc jsonb, field text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(doc -> field) = 'number' then (doc -> field)::numeric end
$$;

-- Fights in real Hunts (not the lab), per quarry and Night.
create view public.quarry_balance
with (security_invoker = true)
as
select
  e.data ->> 'quarry' as quarry,
  public.telemetry_num(e.data, 'night') as night,
  count(*) as fights,
  count(*) filter (where e.data ->> 'result' = 'win') as wins,
  count(*) filter (where e.data ->> 'result' = 'loss') as losses,
  round(
    (count(*) filter (where e.data ->> 'result' = 'win'))::numeric
      / nullif(count(*) filter (where e.data ->> 'result' in ('win', 'loss')), 0),
    3
  ) as win_rate,
  round(avg(public.telemetry_num(e.data, 'beats')), 1) as avg_beats,
  round(avg(public.telemetry_num(e.data, 'vitality_start') - public.telemetry_num(e.data, 'vitality_end')), 1)
    as avg_vitality_lost,
  count(distinct e.install_id) as installs
from public.telemetry_events e
where e.name = 'fight_end' and e.data ->> 'mode' = 'hunt'
group by 1, 2;

comment on view public.quarry_balance is
  'Hunt-mode fights per quarry and Night: fights, wins, losses, win rate, average beats and vitality lost.';

-- Per card: how often it is offered and taken, and how fights go when it is played.
create view public.card_stats
with (security_invoker = true)
as
with offers as (
  select o.card_id, count(*) as offered, count(*) filter (where o.taken) as taken
  from (
    select distinct e.id, c.card_id, (e.data ->> 'taken') = c.card_id as taken
    from public.telemetry_events e
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(e.data -> 'offered') = 'array' then e.data -> 'offered' else '[]'::jsonb end
    ) as c(card_id)
    where e.name = 'card_offer'
  ) o
  group by o.card_id
),
plays as (
  select
    p.card_id,
    count(*) as fights_played_in,
    count(*) filter (where e.data ->> 'result' = 'win') as wins_when_played,
    count(*) filter (where e.data ->> 'result' in ('win', 'loss')) as decided_when_played,
    sum((p.times)::numeric) as times_played
  from public.telemetry_events e
  cross join lateral jsonb_each(
    case when jsonb_typeof(e.data -> 'cards_played') = 'object' then e.data -> 'cards_played' else '{}'::jsonb end
  ) as p(card_id, times)
  where e.name = 'fight_end'
    and coalesce(e.data ->> 'mode', 'hunt') = 'hunt'
    -- (a CASE, because AND does not guarantee the type check runs before the cast)
    and case when jsonb_typeof(p.times) = 'number' then (p.times)::numeric > 0 else false end
  group by p.card_id
)
select
  coalesce(o.card_id, p.card_id) as card_id,
  coalesce(o.offered, 0) as offered,
  coalesce(o.taken, 0) as taken,
  round(o.taken::numeric / nullif(o.offered, 0), 3) as pick_rate,
  coalesce(p.fights_played_in, 0) as fights_played_in,
  coalesce(p.times_played, 0) as times_played,
  round(p.wins_when_played::numeric / nullif(p.decided_when_played, 0), 3) as win_rate_when_played
from offers o
full join plays p on p.card_id = o.card_id;

comment on view public.card_stats is
  'Per card: times offered, times taken, pick rate; Hunt-mode fights it was played in and the win rate of those fights.';

-- Per Coven and pair of implements: how far Hunts get. The pair is order-independent.
create view public.implement_pairs
with (security_invoker = true)
as
with starts as (
  select distinct on (e.session_id, e.data ->> 'hunt_id')
    e.session_id,
    e.data ->> 'hunt_id' as hunt_id,
    e.data ->> 'coven' as coven,
    (
      select string_agg(i, ' + ' order by i)
      from jsonb_array_elements_text(
        case when jsonb_typeof(e.data -> 'implements') = 'array' then e.data -> 'implements' else '[]'::jsonb end
      ) as i
    ) as implements
  from public.telemetry_events e
  where e.name = 'hunt_start' and e.data ? 'hunt_id'
  order by e.session_id, e.data ->> 'hunt_id', e.seq
),
ends as (
  select distinct on (e.session_id, e.data ->> 'hunt_id')
    e.session_id,
    e.data ->> 'hunt_id' as hunt_id,
    e.data ->> 'result' as result,
    public.telemetry_num(e.data, 'night') as night
  from public.telemetry_events e
  where e.name = 'hunt_end' and e.data ? 'hunt_id'
  order by e.session_id, e.data ->> 'hunt_id', e.seq desc
)
select
  s.coven,
  s.implements,
  count(en.result) as hunts,
  count(*) filter (where en.result = 'won') as wins,
  count(*) filter (where en.result = 'lost') as losses,
  count(*) filter (where en.result = 'abandoned') as abandoned,
  round((count(*) filter (where en.result = 'won'))::numeric / nullif(count(en.result), 0), 3) as win_rate,
  round(avg(en.night), 2) as avg_night_reached,
  count(*) filter (where en.result is null) as unfinished
from starts s
left join ends en on en.session_id = s.session_id and en.hunt_id = s.hunt_id
group by s.coven, s.implements;

comment on view public.implement_pairs is
  'Per Coven and implement pair: finished Hunts (hunt_start joined to hunt_end by session_id + hunt_id), wins, average Night reached; unfinished = started but no hunt_end in the same session.';

-- What ends lost Hunts, and on which Night.
create view public.death_causes
with (security_invoker = true)
as
select
  e.data ->> 'killed_by' as killed_by,
  public.telemetry_num(e.data, 'night') as night,
  count(*) as deaths,
  count(distinct e.install_id) as installs
from public.telemetry_events e
where e.name = 'hunt_end' and e.data ->> 'result' = 'lost'
group by 1, 2;

comment on view public.death_causes is 'Lost Hunts grouped by killed_by and Night.';

-- Distinct crashes, most frequent first when you add "order by reports desc".
create view public.crash_summary
with (security_invoker = true)
as
select
  c.signature,
  c.version,
  count(*) as reports,
  count(distinct c.install_id) as installs,
  min(c.received_at) as first_seen,
  max(c.received_at) as last_seen,
  (array_agg(c.kind order by c.received_at desc))[1] as kind,
  (array_agg(c.message order by c.received_at desc))[1] as sample_message,
  (array_agg(c.report_id order by c.received_at desc))[1] as latest_report_id,
  (select s.discord_posted_at from public.crash_signatures s where s.signature = c.signature) as discord_posted_at
from public.crash_reports c
group by c.signature, c.version;

comment on view public.crash_summary is
  'Crash reports grouped by signature and version: count, installs affected, first/last seen, a sample message.';

-- ---------------------------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------------------------
-- Row level security on with no policies, and no privileges for the public API roles. The
-- Edge Functions use service_role (bypasses RLS); you use the Dashboard / SQL Editor.

alter table public.telemetry_events enable row level security;
alter table public.crash_reports enable row level security;
alter table public.crash_signatures enable row level security;
alter table public.feedback_reports enable row level security;
alter table public.game_rate_limits enable row level security;

revoke all on table
  public.telemetry_events, public.crash_reports, public.crash_signatures, public.feedback_reports,
  public.game_rate_limits,
  public.quarry_balance, public.card_stats, public.implement_pairs, public.death_causes, public.crash_summary
from public, anon, authenticated;

revoke all on sequence
  public.telemetry_events_id_seq, public.crash_reports_id_seq, public.feedback_reports_id_seq
from public, anon, authenticated;

revoke all on function
  public.crash_signature_seen(text, text, boolean),
  public.game_rate_limit_hit(text, text, integer, integer),
  public.telemetry_num(jsonb, text)
from public, anon, authenticated;

grant select, insert on table public.telemetry_events to service_role;
grant select, insert on table public.crash_reports to service_role;
grant select, insert, update on table public.crash_signatures to service_role;
grant select, insert, update on table public.feedback_reports to service_role;
grant select, insert, update, delete on table public.game_rate_limits to service_role;
grant select on table
  public.quarry_balance, public.card_stats, public.implement_pairs, public.death_causes, public.crash_summary
to service_role;
grant usage, select on sequence
  public.telemetry_events_id_seq, public.crash_reports_id_seq, public.feedback_reports_id_seq
to service_role;
grant execute on function
  public.crash_signature_seen(text, text, boolean),
  public.game_rate_limit_hit(text, text, integer, integer),
  public.telemetry_num(jsonb, text)
to service_role;
