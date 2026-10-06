-- Hexenbane private playtest applications.
--
-- Two tables:
--   playtest_agreement_versions  the exact text of every Private Playtest Agreement version
--                                ever accepted (append-only)
--   playtest_applications        one row per application, with the agreement version and hash
--                                the applicant accepted
--
-- Nothing here is reachable by the public API keys. The website submits through the
-- submit-playtest-application Edge Function, which uses the service role. You review rows in
-- the Supabase Dashboard (Table Editor), which also uses privileged access.

-- ---------------------------------------------------------------------------------------------
-- Agreement versions
-- ---------------------------------------------------------------------------------------------

create table public.playtest_agreement_versions (
  version text primary key
    constraint playtest_agreement_versions_version_format
    check (version ~ '^HEXENBANE-PLAYTEST-[0-9]{4}-[0-9]{2}-v[0-9]+$'),
  sha256 text not null unique
    constraint playtest_agreement_versions_sha256_format
    check (sha256 ~ '^[0-9a-f]{64}$'),
  body text not null
    constraint playtest_agreement_versions_body_length
    check (char_length(body) between 1 and 100000),
  first_recorded_at timestamptz not null default now(),
  unique (version, sha256)
);

comment on table public.playtest_agreement_versions is
  'Every Private Playtest Agreement version that has been accepted, with its full text. Append-only: rows can never be changed or deleted.';

create function public.playtest_forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: published agreement versions cannot be changed or deleted. Release a new version instead.', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger playtest_agreement_versions_append_only
  before update or delete on public.playtest_agreement_versions
  for each row execute function public.playtest_forbid_change();

create trigger playtest_agreement_versions_no_truncate
  before truncate on public.playtest_agreement_versions
  for each statement execute function public.playtest_forbid_change();

-- ---------------------------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------------------------

create table public.playtest_applications (
  id uuid primary key default gen_random_uuid(),
  public_application_id text not null
    constraint playtest_applications_public_application_id_key unique
    constraint playtest_applications_public_application_id_format
    check (public_application_id ~ '^HEX-PT-[2346789ABCDEFGHJKMNPQRTWXYZ]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Answers (lengths mirror supabase/functions/_shared/application.ts)
  preferred_name text not null check (char_length(preferred_name) between 1 and 60),
  discord_username text not null check (char_length(discord_username) between 2 and 40),
  -- Lower-cased, trimmed, leading "@" removed: the key used to spot repeated applications.
  discord_username_normalized text not null
    generated always as (lower(regexp_replace(btrim(discord_username), '^@+', ''))) stored,
  email text check (email is null or char_length(email) between 3 and 254),
  interest_reason text not null check (char_length(interest_reason) between 1 and 1500),
  similar_games text not null check (char_length(similar_games) between 1 and 1000),
  testing_experience text not null check (char_length(testing_experience) between 1 and 1500),
  cpu text not null check (char_length(cpu) between 1 and 120),
  gpu text not null check (char_length(gpu) between 1 and 120),
  ram text not null check (char_length(ram) between 1 and 40),
  operating_system text not null check (char_length(operating_system) between 1 and 80),
  additional_notes text check (additional_notes is null or char_length(additional_notes) <= 1500),
  joined_discord boolean not null
    constraint playtest_applications_joined_discord_required check (joined_discord),

  -- Agreement evidence (set by the Edge Function, never by the browser; frozen after insert)
  agreement_accepted boolean not null
    constraint playtest_applications_agreement_required check (agreement_accepted),
  agreement_version text not null,
  agreement_hash text not null,
  agreement_accepted_at timestamptz not null,
  constraint playtest_applications_agreement_fkey
    foreign key (agreement_version, agreement_hash)
    references public.playtest_agreement_versions (version, sha256)
    on update restrict on delete restrict,

  -- Review (edit these in the Table Editor)
  status text not null default 'pending'
    constraint playtest_applications_status_check
    check (status in ('pending', 'contacted', 'approved', 'rejected', 'withdrawn')),
  internal_notes text,
  contacted_at timestamptz,
  reviewed_at timestamptz,

  -- Set when the Discord notification was delivered. Null means check #playtest-applications
  -- did not get it (see the Edge Function logs).
  discord_notified_at timestamptz
);

comment on table public.playtest_applications is
  'Hexenbane private playtest applications. Source of truth; Discord notifications are a copy. Edit status, internal_notes, contacted_at and reviewed_at here.';
comment on column public.playtest_applications.public_application_id is 'The ID the applicant sees, e.g. HEX-PT-7KQ3XM. Search by this.';
comment on column public.playtest_applications.discord_username is 'Discord username exactly as submitted.';
comment on column public.playtest_applications.discord_username_normalized is 'Generated: lower-case username used for duplicate detection.';
comment on column public.playtest_applications.agreement_version is 'Agreement version accepted, set by the server. Frozen.';
comment on column public.playtest_applications.agreement_hash is 'SHA-256 of the accepted agreement text, set by the server. Frozen.';
comment on column public.playtest_applications.agreement_accepted_at is 'UTC time the agreement was accepted (the submission time). Frozen.';
comment on column public.playtest_applications.status is 'pending, contacted, approved, rejected or withdrawn.';
comment on column public.playtest_applications.contacted_at is 'Filled automatically the first time status becomes contacted (or approved), if empty.';
comment on column public.playtest_applications.reviewed_at is 'Filled automatically the first time status becomes approved or rejected, if empty.';

-- One open application per Discord username. Rejected or withdrawn applicants may apply again.
create unique index playtest_applications_active_discord_username_key
  on public.playtest_applications (discord_username_normalized)
  where status in ('pending', 'contacted', 'approved');

create index playtest_applications_status_created_at_idx
  on public.playtest_applications (status, created_at desc);

create index playtest_applications_created_at_idx
  on public.playtest_applications (created_at desc);

create index playtest_applications_discord_username_normalized_idx
  on public.playtest_applications (discord_username_normalized);

create index playtest_applications_agreement_version_idx
  on public.playtest_applications (agreement_version);

-- Keeps updated_at current, fills the review timestamps, and freezes the submitted record.
create function public.playtest_applications_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.public_application_id is distinct from old.public_application_id
     or new.created_at is distinct from old.created_at
     or new.agreement_accepted is distinct from old.agreement_accepted
     or new.agreement_version is distinct from old.agreement_version
     or new.agreement_hash is distinct from old.agreement_hash
     or new.agreement_accepted_at is distinct from old.agreement_accepted_at then
    raise exception 'The application ID, creation time and agreement evidence cannot be changed.'
      using errcode = 'restrict_violation';
  end if;

  new.updated_at := now();

  if new.status is distinct from old.status then
    if new.status in ('contacted', 'approved') and new.contacted_at is null then
      new.contacted_at := now();
    end if;
    if new.status in ('approved', 'rejected') and new.reviewed_at is null then
      new.reviewed_at := now();
    end if;
  end if;

  return new;
end;
$$;

create trigger playtest_applications_before_update
  before update on public.playtest_applications
  for each row execute function public.playtest_applications_before_update();

-- ---------------------------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------------------------
-- Row level security on, with no policies: the anon and authenticated roles (the keys a
-- browser can hold) match no rows. Their table privileges are revoked as well, so even a
-- policy added by mistake later would not open the tables. service_role (Edge Function,
-- Dashboard) bypasses RLS.

alter table public.playtest_agreement_versions enable row level security;
alter table public.playtest_applications enable row level security;

revoke all on table public.playtest_agreement_versions from public, anon, authenticated;
revoke all on table public.playtest_applications from public, anon, authenticated;

revoke all on function public.playtest_forbid_change() from public, anon, authenticated;
revoke all on function public.playtest_applications_before_update() from public, anon, authenticated;

grant select, insert, update, delete on table public.playtest_applications to service_role;
grant select, insert on table public.playtest_agreement_versions to service_role;
