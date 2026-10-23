-- Hexenbane playtest: keep debug-menu runs out of the balance numbers (game 0.39.0).
--
-- The game's F1 debug menu marks every event it records once a cheat is used ("cheats": true in
-- the event data). From 0.39.0 the mark belongs to the whole Hunt: the game also marks the
-- Hunt's events still waiting to be sent and every later event of that Hunt, even after a restart.
-- Events already sent before the cheat are caught here instead.
--
-- 1. telemetry_events.cheats: true for an event sent with the mark, and for every event of a Hunt
--    (data.hunt_id) that has one, whichever arrived first. Two triggers keep it so; the events
--    already stored are marked once below.
-- 2. fair_telemetry_events: the events without it. Every balance view now reads that instead of
--    telemetry_events, so a cheated run counts nowhere (quarry_balance, card_stats,
--    implement_pairs, death_causes, card_deck_stats, relic_stats, gun_stats, enemy_rules).
--    telemetry_events itself still holds everything, for looking at a tester's run.

alter table public.telemetry_events add column cheats boolean not null default false;

comment on column public.telemetry_events.cheats is
  'True when the debug menu was used in this event''s Hunt (or, outside a Hunt, its session). The balance views leave these out.';

create index telemetry_events_hunt_id_idx on public.telemetry_events ((data ->> 'hunt_id'))
  where data ? 'hunt_id';

-- An event joins its Hunt's mark, or brings one.
create function public.telemetry_cheats_on_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.data ->> 'cheats' = 'true' then
    new.cheats := true;
  elsif new.data ? 'hunt_id' and exists (
    select from public.telemetry_events e
    where e.cheats and e.data ->> 'hunt_id' = new.data ->> 'hunt_id'
  ) then
    new.cheats := true;
  end if;
  return new;
end;
$$;

-- A marked event marks the rest of its Hunt, sent before it. Security definer: the Edge Functions'
-- role may only insert events, not change them.
create function public.telemetry_cheats_spread()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.telemetry_events
  set cheats = true
  where not cheats and data ->> 'hunt_id' = new.data ->> 'hunt_id';
  return null;
end;
$$;

create trigger telemetry_events_cheats_on_insert
  before insert on public.telemetry_events
  for each row execute function public.telemetry_cheats_on_insert();

create trigger telemetry_events_cheats_spread
  after insert on public.telemetry_events
  for each row when (new.cheats and new.data ? 'hunt_id')
  execute function public.telemetry_cheats_spread();

-- The events already stored.
update public.telemetry_events set cheats = true where data ->> 'cheats' = 'true';
update public.telemetry_events e
set cheats = true
where not e.cheats and e.data ? 'hunt_id' and exists (
  select from public.telemetry_events c
  where c.cheats and c.data ->> 'hunt_id' = e.data ->> 'hunt_id'
);

create view public.fair_telemetry_events
with (security_invoker = true)
as
select * from public.telemetry_events where not cheats;

comment on view public.fair_telemetry_events is
  'telemetry_events without the debug-menu runs (cheats = true): what the balance views read.';

-- The balance views, as before, over fair_telemetry_events.

-- Fights in real Hunts (not the lab), per quarry and Night.
create or replace view public.quarry_balance
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
from public.fair_telemetry_events e
where e.name = 'fight_end' and e.data ->> 'mode' = 'hunt'
group by 1, 2;

-- Per card: how often it is offered and taken, and how fights go when it is played.
create or replace view public.card_stats
with (security_invoker = true)
as
with offers as (
  select o.card_id, count(*) as offered, count(*) filter (where o.taken) as taken
  from (
    select distinct e.id, c.card_id, (e.data ->> 'taken') = c.card_id as taken
    from public.fair_telemetry_events e
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
  from public.fair_telemetry_events e
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

-- Per Coven and pair of implements: how far Hunts get. The pair is order-independent.
create or replace view public.implement_pairs
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
  from public.fair_telemetry_events e
  where e.name = 'hunt_start' and e.data ? 'hunt_id'
  order by e.session_id, e.data ->> 'hunt_id', e.seq
),
ends as (
  select distinct on (e.session_id, e.data ->> 'hunt_id')
    e.session_id,
    e.data ->> 'hunt_id' as hunt_id,
    e.data ->> 'result' as result,
    public.telemetry_num(e.data, 'night') as night
  from public.fair_telemetry_events e
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

-- What ends lost Hunts, and on which Night.
create or replace view public.death_causes
with (security_invoker = true)
as
select
  e.data ->> 'killed_by' as killed_by,
  public.telemetry_num(e.data, 'night') as night,
  count(*) as deaths,
  count(distinct e.install_id) as installs
from public.fair_telemetry_events e
where e.name = 'hunt_end' and e.data ->> 'result' = 'lost'
group by 1, 2;

-- Per card and tier, in Hunt-mode fights: the deck is the fight's `deck` ({"card@tier": copies}),
-- the plays its `plays_by_tier` ({"card@tier": times}).
create or replace view public.card_deck_stats
with (security_invoker = true)
as
with decks as (
  select
    e.version,
    split_part(d.key, '@', 1) as card_id,
    nullif(split_part(d.key, '@', 2), '')::integer as tier,
    e.data ->> 'result' as result,
    case when jsonb_typeof(d.value) = 'number' then (d.value)::numeric end as copies,
    case when jsonb_typeof(e.data -> 'plays_by_tier' -> d.key) = 'number'
      then (e.data -> 'plays_by_tier' -> d.key)::numeric else 0 end as plays
  from public.fair_telemetry_events e
  cross join lateral jsonb_each(
    case when jsonb_typeof(e.data -> 'deck') = 'object' then e.data -> 'deck' else '{}'::jsonb end
  ) as d(key, value)
  where e.name = 'fight_end'
    and coalesce(e.data ->> 'mode', 'hunt') = 'hunt'
    and d.key ~ '^[^@]+@[0-9]{1,3}$'
)
select
  version,
  card_id,
  tier,
  count(*) as fights_in_deck,
  count(*) filter (where result = 'win') as wins,
  round((count(*) filter (where result = 'win'))::numeric
    / nullif(count(*) filter (where result in ('win', 'loss')), 0), 3) as win_rate_in_deck,
  round(avg(copies), 2) as avg_copies,
  count(*) filter (where plays > 0) as fights_played_in,
  round(sum(plays) / nullif(count(*), 0), 2) as plays_per_fight,
  round((count(*) filter (where plays > 0 and result = 'win'))::numeric
    / nullif(count(*) filter (where plays > 0 and result in ('win', 'loss')), 0), 3) as win_rate_when_played
from decks
group by version, card_id, tier;

-- Per relic: the fights and the Hunts it was carried in.
create or replace view public.relic_stats
with (security_invoker = true)
as
with fights as (
  select
    e.version,
    r.relic,
    count(*) as fights,
    round((count(*) filter (where e.data ->> 'result' = 'win'))::numeric
      / nullif(count(*) filter (where e.data ->> 'result' in ('win', 'loss')), 0), 3) as fight_win_rate,
    round(avg(public.telemetry_num(e.data, 'vitality_start') - public.telemetry_num(e.data, 'vitality_end')), 1)
      as avg_vitality_lost
  from public.fair_telemetry_events e
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(e.data -> 'relics') = 'array' then e.data -> 'relics' else '[]'::jsonb end
  ) as r(relic)
  where e.name = 'fight_end' and coalesce(e.data ->> 'mode', 'hunt') = 'hunt'
  group by e.version, r.relic
),
hunts as (
  select
    e.version,
    r.relic,
    count(*) as hunts_ended_with,
    count(*) filter (where e.data ->> 'result' = 'won') as hunts_won,
    round(avg(public.telemetry_num(e.data, 'night')), 2) as avg_night_reached
  from public.fair_telemetry_events e
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(e.data -> 'relics') = 'array' then e.data -> 'relics' else '[]'::jsonb end
  ) as r(relic)
  where e.name = 'hunt_end'
  group by e.version, r.relic
)
select
  coalesce(f.version, h.version) as version,
  coalesce(f.relic, h.relic) as relic,
  coalesce(f.fights, 0) as fights,
  f.fight_win_rate,
  f.avg_vitality_lost,
  coalesce(h.hunts_ended_with, 0) as hunts_ended_with,
  coalesce(h.hunts_won, 0) as hunts_won,
  h.avg_night_reached
from fights f
full join hunts h on h.version = f.version and h.relic = f.relic;

-- Per gun, Reforging and grade (0 Crude, 1 Proven, 2 Masterwork; -1 never reforged).
create or replace view public.gun_stats
with (security_invoker = true)
as
select
  e.version,
  e.data -> 'implements' ->> 0 as gun,
  coalesce(nullif(e.data -> 'gun' ->> 'reforge', ''), '(none)') as reforge,
  public.telemetry_num(e.data -> 'gun', 'grade') as grade,
  count(*) as fights,
  round((count(*) filter (where e.data ->> 'result' = 'win'))::numeric
    / nullif(count(*) filter (where e.data ->> 'result' in ('win', 'loss')), 0), 3) as win_rate,
  round(avg(public.telemetry_num(e.data, 'vitality_start') - public.telemetry_num(e.data, 'vitality_end')), 1)
    as avg_vitality_lost,
  round(avg(public.telemetry_num(e.data, 'beats')), 1) as avg_beats,
  count(*) filter (where (e.data -> 'gun' ->> 'retempered') = 'true') as retempered_fights,
  count(distinct e.install_id) as installs
from public.fair_telemetry_events e
where e.name = 'fight_end' and coalesce(e.data ->> 'mode', 'hunt') = 'hunt' and e.data ? 'gun'
group by 1, 2, 3, 4;

-- Per quarry and Night: how often its Rend, Disarm and traits bit.
create or replace view public.enemy_rules
with (security_invoker = true)
as
with fights as (
  select
    e.version,
    e.data ->> 'quarry' as quarry,
    public.telemetry_num(e.data, 'night') as night,
    (
      select string_agg(t, ', ' order by t)
      from jsonb_array_elements_text(
        case when jsonb_typeof(e.data -> 'quarry_traits') = 'array' then e.data -> 'quarry_traits' else '[]'::jsonb end
      ) as t
    ) as traits,
    e.data ->> 'result' as result,
    public.telemetry_num(e.data, 'rends') as rends,
    public.telemetry_num(e.data, 'rend_guard') as rend_guard,
    public.telemetry_num(e.data, 'disarms') as disarms,
    (
      select coalesce(sum(case when jsonb_typeof(v) = 'number' then v::numeric else 0 end), 0)
      from jsonb_each(
        case when jsonb_typeof(e.data -> 'traits_fired') = 'object' then e.data -> 'traits_fired' else '{}'::jsonb end
      ) as tf(k, v)
    ) as trait_fires
  from public.fair_telemetry_events e
  where e.name = 'fight_end' and coalesce(e.data ->> 'mode', 'hunt') = 'hunt' and e.data ? 'rends'
)
select
  version,
  quarry,
  night,
  traits,
  count(*) as fights,
  round((count(*) filter (where result = 'win'))::numeric
    / nullif(count(*) filter (where result in ('win', 'loss')), 0), 3) as win_rate,
  round(avg(rends), 2) as rends_per_fight,
  round(avg(rend_guard), 1) as guard_rent_per_fight,
  round(avg(disarms), 2) as disarms_per_fight,
  round(avg(trait_fires), 2) as trait_fires_per_fight
from fights
group by version, quarry, night, traits;

revoke all on table public.fair_telemetry_events from public, anon, authenticated;
grant select on table public.fair_telemetry_events to service_role;

revoke all on function
  public.telemetry_cheats_on_insert(),
  public.telemetry_cheats_spread()
from public, anon, authenticated;
