-- Fantasy League Manager — Supabase schema and RLS policies.
-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query).
-- Safe to re-run: idempotent via "if not exists" / "create or replace".

-- ============================================================================
-- 1. owners — maps auth.users.id → team_id (e.g. "jeff", "matt", ...)
-- ============================================================================
create table if not exists public.owners (
  id              uuid primary key references auth.users(id) on delete cascade,
  team_id         text unique not null,
  is_commissioner boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Helper: is the current user a commissioner?
create or replace function public.is_commissioner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_commissioner from public.owners where id = auth.uid()),
    false
  );
$$;

-- Helper: what team_id does the current user own?
create or replace function public.my_team_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select team_id from public.owners where id = auth.uid();
$$;

alter table public.owners enable row level security;

drop policy if exists "owners_select_all"     on public.owners;
drop policy if exists "owners_insert_self"    on public.owners;
drop policy if exists "owners_update_admin"   on public.owners;
drop policy if exists "owners_delete_admin"   on public.owners;

create policy "owners_select_all"
  on public.owners for select
  using (auth.role() = 'authenticated');

-- A user can claim an unclaimed team_id by inserting a row for themselves.
create policy "owners_insert_self"
  on public.owners for insert
  with check (id = auth.uid() and not is_commissioner);

-- Only commissioners can update or reassign teams.
create policy "owners_update_admin"
  on public.owners for update
  using (public.is_commissioner());

create policy "owners_delete_admin"
  on public.owners for delete
  using (public.is_commissioner());


-- ============================================================================
-- 2. keeper_selections — replaces flm_eligible_keepers in localStorage
-- ============================================================================
create table if not exists public.keeper_selections (
  team_id       text not null,
  player_name   text not null,
  keeper        boolean not null default false,
  minor_keeper  boolean not null default false,
  rule5         boolean not null default false,
  trade_block   boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (team_id, player_name)
);

alter table public.keeper_selections enable row level security;

drop policy if exists "ks_select_all"      on public.keeper_selections;
drop policy if exists "ks_write_owner"     on public.keeper_selections;

create policy "ks_select_all"
  on public.keeper_selections for select
  using (auth.role() = 'authenticated');

create policy "ks_write_owner"
  on public.keeper_selections for all
  using (team_id = public.my_team_id() or public.is_commissioner())
  with check (team_id = public.my_team_id() or public.is_commissioner());


-- ============================================================================
-- 3. trades — replaces flm_trades
-- ============================================================================
create table if not exists public.trades (
  id              uuid primary key default gen_random_uuid(),
  date            text not null,
  team1           text not null,
  team2           text not null,
  team1_receives  jsonb not null default '[]'::jsonb,
  team2_receives  jsonb not null default '[]'::jsonb,
  notes           text default '',
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now()
);

alter table public.trades enable row level security;

drop policy if exists "trades_select_all"     on public.trades;
drop policy if exists "trades_write_party"    on public.trades;
drop policy if exists "trades_insert_party"   on public.trades;
drop policy if exists "trades_update_party"   on public.trades;
drop policy if exists "trades_delete_admin"   on public.trades;

create policy "trades_select_all"
  on public.trades for select
  using (auth.role() = 'authenticated');

-- Insert/update: parties to the trade or commissioner.
create policy "trades_insert_party"
  on public.trades for insert
  with check (
    team1 = public.my_team_id()
    or team2 = public.my_team_id()
    or public.is_commissioner()
  );

create policy "trades_update_party"
  on public.trades for update
  using (
    team1 = public.my_team_id()
    or team2 = public.my_team_id()
    or public.is_commissioner()
  )
  with check (
    team1 = public.my_team_id()
    or team2 = public.my_team_id()
    or public.is_commissioner()
  );

-- Delete: commissioner only.
create policy "trades_delete_admin"
  on public.trades for delete
  using (public.is_commissioner());


-- ============================================================================
-- 4. league_state — singleton rows for draft, rule5, etc. (commissioner-only)
-- ============================================================================
create table if not exists public.league_state (
  key         text primary key,        -- e.g. 'draft_2027', 'rule5'
  state       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.league_state enable row level security;

drop policy if exists "ls_select_all"     on public.league_state;
drop policy if exists "ls_write_admin"    on public.league_state;

create policy "ls_select_all"
  on public.league_state for select
  using (auth.role() = 'authenticated');

create policy "ls_write_admin"
  on public.league_state for all
  using (public.is_commissioner())
  with check (public.is_commissioner());


-- ============================================================================
-- 5b. invited_emails — pre-assigned team mapping for new owners. When a
--     freshly-signed-up user has an entry here, claim_invited_team() pre-fills
--     their owners row so they skip the "Pick Your Team" screen.
-- ============================================================================
create table if not exists public.invited_emails (
  email             text primary key,
  team_id           text not null,
  is_commissioner   boolean not null default false,
  created_at        timestamptz not null default now()
);

alter table public.invited_emails enable row level security;

drop policy if exists "ie_select_admin" on public.invited_emails;
drop policy if exists "ie_write_admin"  on public.invited_emails;

-- Only commissioners can read/write the table directly. The is_email_invited()
-- function below exposes a boolean check to anon for the login screen.
create policy "ie_select_admin"
  on public.invited_emails for select
  using (public.is_commissioner());

create policy "ie_write_admin"
  on public.invited_emails for all
  using (public.is_commissioner())
  with check (public.is_commissioner());

-- Anon-callable: returns true if the supplied email is invited.
create or replace function public.is_email_invited(email_to_check text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.invited_emails
    where lower(email) = lower(email_to_check)
  );
$$;
grant execute on function public.is_email_invited(text) to anon, authenticated;

-- Authenticated user calls this once after login. If they don't already have
-- an owners row AND there's an invited_emails entry matching their email,
-- creates the owners row with the pre-mapped team_id + is_commissioner.
create or replace function public.claim_invited_team()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_email text;
  inv record;
  -- Canonical 12-team list (matches LEAGUE_DATA.teams in js/data.js).
  -- Guards against a typo in send_invite.py creating a permanently broken claim.
  known_teams text[] := array['jeff','matt','jesse','sam','saxton','aj','corey','dave','josh-doug','larry','zack','glicksman'];
begin
  if exists (select 1 from public.owners where id = auth.uid()) then
    return;
  end if;
  select email into caller_email from auth.users where id = auth.uid();
  if caller_email is null then return; end if;
  select * into inv from public.invited_emails where lower(email) = lower(caller_email);
  if inv.email is null then return; end if;
  if not (inv.team_id = any(known_teams)) then
    raise exception 'invited_emails.team_id % is not a valid team', inv.team_id;
  end if;
  insert into public.owners (id, team_id, is_commissioner)
  values (auth.uid(), inv.team_id, coalesce(inv.is_commissioner, false))
  on conflict (id) do nothing;
end;
$$;
grant execute on function public.claim_invited_team() to authenticated;


-- ============================================================================
-- 5. callup_overrides — replaces flm_callup_prices (commissioner-only writes)
-- ============================================================================
create table if not exists public.callup_overrides (
  player_name text primary key,
  price       integer,
  year        integer,
  updated_at  timestamptz not null default now()
);

alter table public.callup_overrides enable row level security;

drop policy if exists "co_select_all"  on public.callup_overrides;
drop policy if exists "co_write_admin" on public.callup_overrides;

create policy "co_select_all"
  on public.callup_overrides for select
  using (auth.role() = 'authenticated');

create policy "co_write_admin"
  on public.callup_overrides for all
  using (public.is_commissioner())
  with check (public.is_commissioner());


-- ============================================================================
-- 5c. activity_log — append-only league activity feed.
--     Each row records something happening: keeper toggled, trade saved,
--     draft pick made, etc. Read-by-all, write-by-self, delete by commish.
-- ============================================================================
create table if not exists public.activity_log (
  id              uuid primary key default gen_random_uuid(),
  type            text not null,
  actor_team_id   text,
  target_team_id  text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_activity_log_created_at
  on public.activity_log (created_at desc);

alter table public.activity_log enable row level security;

drop policy if exists "al_select_all"   on public.activity_log;
drop policy if exists "al_insert_self"  on public.activity_log;
drop policy if exists "al_delete_admin" on public.activity_log;

create policy "al_select_all"
  on public.activity_log for select
  using (auth.role() = 'authenticated');

create policy "al_insert_self"
  on public.activity_log for insert
  with check (
    auth.role() = 'authenticated'
    and (
      public.is_commissioner()
      or (
        actor_team_id = public.my_team_id()
        and (
          target_team_id is null
          or target_team_id = public.my_team_id()
          -- For trade_recorded events, the counterparty must be a real trade
          -- partner — verified against the trades table.
          or (
            type = 'trade_recorded'
            and exists (
              select 1 from public.trades t
              where (t.team1 = actor_team_id and t.team2 = target_team_id)
                 or (t.team1 = target_team_id and t.team2 = actor_team_id)
            )
          )
        )
        -- trade_deleted is commish-only at the DB layer.
        and type <> 'trade_deleted'
      )
    )
  );

create policy "al_delete_admin"
  on public.activity_log for delete
  using (public.is_commissioner());


-- ============================================================================
-- 5d. Realtime publication — add the owners table so the client can react
--     to commissioner promotion/demotion without a reload. Idempotent.
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'owners'
  ) then
    alter publication supabase_realtime add table public.owners;
  end if;
end $$;


-- ============================================================================
-- 6. GRANTs — Supabase by default doesn't grant write privileges to
--    `authenticated`, so RLS alone isn't enough. Without these, INSERTs
--    fail with "permission denied for table".
-- ============================================================================
grant usage on schema public to authenticated;

grant select, insert, update, delete on table
  public.owners,
  public.keeper_selections,
  public.trades,
  public.league_state,
  public.callup_overrides,
  public.invited_emails
to authenticated;

grant select, insert on public.activity_log to authenticated;
grant delete on public.activity_log to authenticated;  -- gated by RLS to commish

grant select, insert, update, delete on public.invited_emails to service_role;
grant select, insert, delete on public.activity_log to service_role;
grant select, insert, update, delete on public.owners to service_role;

grant execute on function public.is_commissioner() to authenticated;
grant execute on function public.my_team_id() to authenticated;


-- ============================================================================
-- 7. updated_at triggers (so writes auto-stamp the row)
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ks_touch on public.keeper_selections;
create trigger ks_touch before update on public.keeper_selections
  for each row execute function public.touch_updated_at();

drop trigger if exists ls_touch on public.league_state;
create trigger ls_touch before update on public.league_state
  for each row execute function public.touch_updated_at();

drop trigger if exists co_touch on public.callup_overrides;
create trigger co_touch before update on public.callup_overrides
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- BOOTSTRAP — run AFTER Jeff has logged in once via magic link.
-- This claims 'jeff' as Jeff's team and makes him a commissioner.
-- ============================================================================
--
-- insert into public.owners (id, team_id, is_commissioner)
-- select id, 'jeff', true from auth.users where email = 'jwarshafsky@gmail.com'
-- on conflict (id) do update
--   set team_id = excluded.team_id, is_commissioner = excluded.is_commissioner;
--
-- Repeat for Dave once you have his email + first login:
--
-- insert into public.owners (id, team_id, is_commissioner)
-- select id, 'dave', true from auth.users where email = 'DAVE_EMAIL_HERE'
-- on conflict (id) do update
--   set team_id = excluded.team_id, is_commissioner = excluded.is_commissioner;
