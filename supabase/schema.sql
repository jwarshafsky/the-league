-- Fantasy League Manager — Supabase schema and RLS policies.
-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query).
-- Safe to re-run: idempotent via "if not exists" / "create or replace".

-- ============================================================================
-- 1. owners — maps auth.users.id → team_id (e.g. "jeff", "matt", ...)
-- ============================================================================
create table if not exists public.owners (
  id              uuid primary key references auth.users(id) on delete cascade,
  -- team_id is NOT unique: a team can have multiple managers (co-managers
  -- like Josh/Doug). The 2026-05-13 migration drops the old UNIQUE
  -- constraint; new projects pick this up directly.
  team_id         text not null,
  is_commissioner boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists owners_team_id_idx on public.owners(team_id);

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

-- No INSERT policy: legitimate inserts go through claim_invited_team()
-- (security definer, bypasses RLS). Direct INSERT from a client is denied,
-- which closes a race-window where a user could claim an unclaimed team_id
-- before the auto-claim runs.

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

-- Update: commissioners only. A party to a trade can INSERT a new trade row
-- but cannot rewrite an existing one's contents (would let either side
-- retroactively re-author the deal). To fix a recorded trade, the commish
-- deletes it and the parties re-record.
create policy "trades_update_party"
  on public.trades for update
  using (public.is_commissioner())
  with check (public.is_commissioner());

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
  version     bigint not null default 0,  -- optimistic-concurrency counter (save_league_state)
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

-- Compare-and-swap writer. All read-modify-write callers (browser + crons)
-- pass the version they read; a stale version raises a version_conflict
-- error so the caller re-fetches instead of silently clobbering a concurrent
-- write (e.g. the draft-clock cron erasing a just-submitted pick).
-- SECURITY INVOKER, so ls_write_admin still gates who can write.
create or replace function public.save_league_state(
  p_key text, p_state jsonb, p_expected_version bigint
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_version bigint;
begin
  insert into public.league_state as ls (key, state, version)
  values (p_key, p_state, coalesce(p_expected_version, 0) + 1)
  on conflict (key) do update
    set state   = excluded.state,
        version = ls.version + 1
    where ls.version = coalesce(p_expected_version, 0)
  returning version into new_version;
  if new_version is null then
    -- NOTE: deliberately NOT errcode 40001 — PostgREST auto-retries
    -- serialization_failure, which turns a conflict into a request timeout.
    raise exception 'version_conflict for key %', p_key;
  end if;
  return new_version;
end;
$$;
revoke all on function public.save_league_state(text, jsonb, bigint) from public, anon;
grant execute on function public.save_league_state(text, jsonb, bigint) to authenticated, service_role;


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

-- Manual claim path: a logged-in user (typically the bootstrap commissioner)
-- selects their team explicitly. Validates team is one of the 12 known IDs
-- AND not already claimed, so a user can't grab an unclaimed teammate's
-- slot via direct table INSERT (the owners INSERT policy is intentionally
-- absent — all legitimate inserts go through the security-definer RPCs).
create or replace function public.claim_specific_team(team_id_to_claim text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  known_teams text[] := array['jeff','matt','jesse','sam','saxton','aj','corey','dave','josh-doug','larry','zack','glicksman'];
begin
  if exists (select 1 from public.owners where id = auth.uid()) then
    raise exception 'You already have a team claimed';
  end if;
  if not (team_id_to_claim = any(known_teams)) then
    raise exception 'Invalid team_id: %', team_id_to_claim;
  end if;
  if exists (select 1 from public.owners where team_id = team_id_to_claim) then
    raise exception 'Team % is already claimed by another owner', team_id_to_claim;
  end if;
  insert into public.owners (id, team_id, is_commissioner)
  values (auth.uid(), team_id_to_claim, false);
end;
$$;
grant execute on function public.claim_specific_team(text) to authenticated;


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
-- 5g. roster_moves — owner- or commissioner-recorded minors↔callups
--     transitions. Drives the live derivation of each team's minors and
--     callups arrays in app.js (alongside the trade log and the static
--     data.js anchor). Owners can move their own players; commissioners
--     can move anyone's.
-- ============================================================================
create table if not exists public.roster_moves (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  player_name  text not null,
  team_id      text not null,
  created_by   uuid references auth.users(id),
  at           timestamptz not null default now(),
  constraint roster_moves_kind_check check (kind in ('callup', 'demote', 'drop'))
);
create index if not exists idx_roster_moves_team_at
  on public.roster_moves (team_id, at);

alter table public.roster_moves enable row level security;

drop policy if exists "rm_select_all"  on public.roster_moves;
drop policy if exists "rm_insert_self" on public.roster_moves;
drop policy if exists "rm_delete_admin" on public.roster_moves;

create policy "rm_select_all"
  on public.roster_moves for select
  using (auth.role() = 'authenticated');

create policy "rm_insert_self"
  on public.roster_moves for insert
  with check (
    auth.role() = 'authenticated'
    and (team_id = public.my_team_id() or public.is_commissioner())
  );

create policy "rm_delete_admin"
  on public.roster_moves for delete
  using (public.is_commissioner());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='roster_moves'
  ) then
    alter publication supabase_realtime add table public.roster_moves;
  end if;
end $$;


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
-- 5e. trade_proposals — trade *proposals* (separate from recorded trades).
--     A proposal lives in a thread (shared id across the whole back-and-forth
--     including counters). Accept records a real row in trades. Counter
--     creates a new proposal in the same thread; the parent is marked
--     'countered' as a terminal state.
-- ============================================================================
create table if not exists public.trade_proposals (
  id                  uuid primary key default gen_random_uuid(),
  thread_id           uuid not null default gen_random_uuid(),
  from_team_id        text not null,
  to_team_id          text not null,
  team1_receives      jsonb not null default '[]'::jsonb,
  team2_receives      jsonb not null default '[]'::jsonb,
  notes               text default '',
  status              text not null default 'pending',
  parent_proposal_id  uuid references public.trade_proposals(id),
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint trade_proposals_status_check
    check (status in ('pending','accepted','rejected','withdrawn','countered'))
);
create index if not exists idx_trade_proposals_thread
  on public.trade_proposals (thread_id, created_at);
create index if not exists idx_trade_proposals_to_team
  on public.trade_proposals (to_team_id, status);
create index if not exists idx_trade_proposals_from_team
  on public.trade_proposals (from_team_id, status);

alter table public.trade_proposals enable row level security;

drop policy if exists "tp_select_party"  on public.trade_proposals;
drop policy if exists "tp_insert_self"   on public.trade_proposals;
drop policy if exists "tp_update_party"  on public.trade_proposals;
drop policy if exists "tp_delete_admin"  on public.trade_proposals;

-- Parties (sender or recipient) and commissioners can see proposals.
create policy "tp_select_party"
  on public.trade_proposals for select
  using (
    public.is_commissioner()
    or from_team_id = public.my_team_id()
    or to_team_id   = public.my_team_id()
  );

-- Sender of a new proposal must be the current user's team. Recipient must
-- be different from sender. (No constraint on team_id values here — the
-- known_teams list is enforced via the FK shape and the data model; an
-- invalid id would simply never have a counterparty.)
create policy "tp_insert_self"
  on public.trade_proposals for insert
  with check (
    auth.role() = 'authenticated'
    and from_team_id = public.my_team_id()
    and to_team_id   <> public.my_team_id()
  );

-- Status transitions: parties can update. The application enforces who-can-
-- do-what (recipient: accept/reject/counter; sender: withdraw); RLS just
-- bounds it to the parties.
create policy "tp_update_party"
  on public.trade_proposals for update
  using (
    public.is_commissioner()
    or from_team_id = public.my_team_id()
    or to_team_id   = public.my_team_id()
  )
  with check (
    public.is_commissioner()
    or from_team_id = public.my_team_id()
    or to_team_id   = public.my_team_id()
  );

create policy "tp_delete_admin"
  on public.trade_proposals for delete
  using (public.is_commissioner());


-- ============================================================================
-- 5f. trade_proposal_messages — chat thread per proposal *thread*.
--     Tied to thread_id (not proposal_id) so messages persist across
--     counter rounds in the same negotiation.
-- ============================================================================
create table if not exists public.trade_proposal_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null,
  from_team_id text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_trade_proposal_messages_thread
  on public.trade_proposal_messages (thread_id, created_at);

alter table public.trade_proposal_messages enable row level security;

drop policy if exists "tpm_select_party" on public.trade_proposal_messages;
drop policy if exists "tpm_insert_self"  on public.trade_proposal_messages;
drop policy if exists "tpm_delete_admin" on public.trade_proposal_messages;

-- Read: parties to ANY proposal in this thread. (We allow this via existence
-- check on trade_proposals so a user can see the message thread iff they're
-- a party to at least one proposal in it.)
create policy "tpm_select_party"
  on public.trade_proposal_messages for select
  using (
    public.is_commissioner()
    or exists (
      select 1 from public.trade_proposals tp
      where tp.thread_id = trade_proposal_messages.thread_id
        and (tp.from_team_id = public.my_team_id() or tp.to_team_id = public.my_team_id())
    )
  );

-- Write: sender's team is the current user's team AND user is a party to
-- a proposal in this thread.
create policy "tpm_insert_self"
  on public.trade_proposal_messages for insert
  with check (
    auth.role() = 'authenticated'
    and from_team_id = public.my_team_id()
    and exists (
      select 1 from public.trade_proposals tp
      where tp.thread_id = trade_proposal_messages.thread_id
        and (tp.from_team_id = public.my_team_id() or tp.to_team_id = public.my_team_id())
    )
  );

create policy "tpm_delete_admin"
  on public.trade_proposal_messages for delete
  using (public.is_commissioner());

-- Add the new tables to the realtime publication.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='trade_proposals') then
    alter publication supabase_realtime add table public.trade_proposals;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='trade_proposal_messages') then
    alter publication supabase_realtime add table public.trade_proposal_messages;
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
  public.invited_emails,
  public.trade_proposals
to authenticated;

grant select, insert on public.activity_log to authenticated;
grant delete on public.activity_log to authenticated;  -- gated by RLS to commish

grant select, insert on public.trade_proposal_messages to authenticated;
grant delete on public.trade_proposal_messages to authenticated;  -- gated by RLS

grant select, insert on public.roster_moves to authenticated;
grant delete on public.roster_moves to authenticated;  -- gated by RLS to commish

grant select, insert, update, delete on public.invited_emails to service_role;
grant select, insert, delete on public.activity_log to service_role;
grant select, insert, update, delete on public.owners to service_role;
grant select, insert, update, delete on public.trade_proposals to service_role;
grant select, insert, delete on public.trade_proposal_messages to service_role;
grant select, insert, delete on public.roster_moves to service_role;
-- Read access for the rules-bot edge function (assembles league context for Gemini).
-- Write access for the scheduled GitHub Actions workflows: notify_instant
-- updates league_state.notify_marker, the ESPN sync workflow writes
-- league_state.espn_sync_status, etc.
grant select, insert, update, delete on public.league_state to service_role;
grant select on public.trades          to service_role;
grant select on public.keeper_selections to service_role;
grant select on public.callup_overrides  to service_role;

grant execute on function public.is_commissioner() to authenticated;
grant execute on function public.my_team_id() to authenticated;


-- ============================================================================
-- 7. updated_at triggers (so writes auto-stamp the row)
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
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

drop trigger if exists tp_touch on public.trade_proposals;
create trigger tp_touch before update on public.trade_proposals
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- 11. notification_prefs — per-team email + push preferences
-- ============================================================================
create table if not exists public.notification_prefs (
  team_id     text primary key,
  prefs       jsonb not null default '{}'::jsonb,
  receive_all boolean not null default false,
  email       text,
  updated_at  timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;

drop policy if exists "np_select_all"  on public.notification_prefs;
drop policy if exists "np_select_own"  on public.notification_prefs;
drop policy if exists "np_write_owner" on public.notification_prefs;

-- Own row (or commish) only: the row carries the team's contact email, which
-- must not be readable league-wide. Server scripts use the service role.
create policy "np_select_own"
  on public.notification_prefs for select
  using (team_id = public.my_team_id() or public.is_commissioner());

create policy "np_write_owner"
  on public.notification_prefs for all
  using (team_id = public.my_team_id() or public.is_commissioner())
  with check (team_id = public.my_team_id() or public.is_commissioner());

drop trigger if exists np_touch on public.notification_prefs;
create trigger np_touch before update on public.notification_prefs
  for each row execute function public.touch_updated_at();

-- Explicit grants — Supabase only auto-grants new public-schema tables in
-- some project configurations. Without these, RLS isn't even evaluated and
-- writes fail with "permission denied for table notification_prefs".
grant select, insert, update, delete on public.notification_prefs to authenticated;
grant all on public.notification_prefs to service_role;


-- ============================================================================
-- 12. push_subscriptions — one row per device-level Web Push subscription
-- ============================================================================
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  team_id     text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth_key    text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create unique index if not exists push_subscriptions_endpoint_idx
  on public.push_subscriptions(endpoint);

alter table public.push_subscriptions enable row level security;

drop policy if exists "ps_select_own"   on public.push_subscriptions;
drop policy if exists "ps_insert_own"   on public.push_subscriptions;
drop policy if exists "ps_delete_own"   on public.push_subscriptions;

create policy "ps_select_own"
  on public.push_subscriptions for select
  using (user_id = auth.uid() or public.is_commissioner());

create policy "ps_insert_own"
  on public.push_subscriptions for insert
  with check (user_id = auth.uid());

create policy "ps_delete_own"
  on public.push_subscriptions for delete
  using (user_id = auth.uid() or public.is_commissioner());

grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;


-- ============================================================================
-- 13. league_messages — shared message board, anyone can post their own,
--      commissioners can delete anything.
-- ============================================================================
create table if not exists public.league_messages (
  id          uuid primary key default gen_random_uuid(),
  team_id     text not null,
  user_id     uuid references auth.users(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists league_messages_created_at_idx
  on public.league_messages(created_at);

alter table public.league_messages enable row level security;

drop policy if exists "lm_select_all"    on public.league_messages;
drop policy if exists "lm_insert_own"    on public.league_messages;
drop policy if exists "lm_delete_admin"  on public.league_messages;

create policy "lm_select_all"
  on public.league_messages for select
  using (auth.role() = 'authenticated');

-- Insert: only as your own team, and if you stamp a user_id it must be your
-- own. Without the user_id clause an owner could post a row bearing another
-- user's user_id, muddying who is allowed to delete it (lm_delete_admin keys
-- delete rights off user_id = auth.uid()).
create policy "lm_insert_own"
  on public.league_messages for insert
  with check (
    team_id = public.my_team_id()
    and (user_id is null or user_id = auth.uid())
  );

-- Delete: commissioners can clear anyone, authors can remove their own row.
create policy "lm_delete_admin"
  on public.league_messages for delete
  using (public.is_commissioner() or user_id = auth.uid());

grant select, insert, delete on public.league_messages to authenticated;
grant all on public.league_messages to service_role;


-- ============================================================================
-- Realtime publication — tables the client subscribes to. Idempotent. The
-- subscribe handlers in js/db.js silently no-op if a table isn't published,
-- so missing entries here would not raise an error but would break live
-- updates (message board, trades, keeper picks, etc.) on a fresh project.
-- ============================================================================
do $$
declare
  t text;
  realtime_tables text[] := array[
    'trades',
    'keeper_selections',
    'league_state',
    'callup_overrides',
    'activity_log',
    'notification_prefs',
    'league_messages'
  ];
begin
  foreach t in array realtime_tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


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
