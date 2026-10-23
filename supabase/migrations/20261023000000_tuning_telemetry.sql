-- Hexenbane playtest: telemetry for card and system tuning (game 0.38.0).
--
-- 1. Accepts the game's `scene_puzzle` event. The game has sent it in place of `scene_lead` since
--    the Ritual Reconstruction Investigations (0.15.0), and one unknown event refuses the whole
--    batch, so every batch holding a Scene's puzzle was dropped, fights and card offers with it.
--    `scene_lead` stays accepted for older builds.
-- 2. Views over the new fight_end and hunt_end fields, each split by game version so one build's
--    numbers can be read on their own:
--      card_deck_stats  per card and tier: fights it was in the deck for, their win rate, and how
--                       often it was played
--      relic_stats      per relic: fights and Hunts carried in, and how they went
--      gun_stats        per gun, Reforging and grade: fights, win rate, Health lost
--      enemy_rules      per quarry and Night: Rend, Disarm and trait triggers per fight
--
-- Like the first telemetry migration: views are security_invoker and not readable by the public
-- keys; only service_role (and you, in the SQL Editor) can read them.

alter table public.telemetry_events drop constraint telemetry_events_name_check;
alter table public.telemetry_events add constraint telemetry_events_name_check
  check (name in ('session_start', 'session_end', 'hunt_start', 'fight_end', 'card_offer', 'boss_reward',
                  'purchase', 'inscription_cut', 'scene_lead', 'scene_puzzle', 'hunt_end', 'feedback_sent'));

-- Per card and tier, in Hunt-mode fights: the deck is the fight's `deck` ({"card@tier": copies}),
-- the plays its `plays_by_tier` ({"card@tier": times}).
create view public.card_deck_stats
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
  from public.telemetry_events e
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

comment on view public.card_deck_stats is
  'Per game version, card and tier (Hunt-mode fights): fights it was in the deck for and their win rate, average copies, how often it was played and the win rate when played.';

-- Per relic: the fights and the Hunts it was carried in.
create view public.relic_stats
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
  from public.telemetry_events e
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
  from public.telemetry_events e
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

comment on view public.relic_stats is
  'Per game version and relic: Hunt-mode fights carried in (win rate, Health lost) and Hunts that ended holding it (wins, average Night reached).';

-- Per gun, Reforging and grade (0 Crude, 1 Proven, 2 Masterwork; -1 never reforged).
create view public.gun_stats
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
from public.telemetry_events e
where e.name = 'fight_end' and coalesce(e.data ->> 'mode', 'hunt') = 'hunt' and e.data ? 'gun'
group by 1, 2, 3, 4;

comment on view public.gun_stats is
  'Per game version, gun, Reforging and grade (Hunt-mode fights): fights, win rate, Health lost, beats, and how many were fought re-tempered.';

-- Per quarry and Night: how often its Rend, Disarm and traits bit.
create view public.enemy_rules
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
  from public.telemetry_events e
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

comment on view public.enemy_rules is
  'Per game version, quarry and Night (Hunt-mode fights from 0.38.0): its traits, win rate, and Rend, Disarm and trait triggers per fight.';

revoke all on table
  public.card_deck_stats, public.relic_stats, public.gun_stats, public.enemy_rules
from public, anon, authenticated;

grant select on table
  public.card_deck_stats, public.relic_stats, public.gun_stats, public.enemy_rules
to service_role;
