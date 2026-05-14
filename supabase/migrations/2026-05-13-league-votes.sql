-- League votes — one row per (vote_id, team_id) recording a manager's
-- ballot. The vote *metadata* (title, description, opens_at, closes_at,
-- options) lives in league_state under key="active_vote" and is readable
-- by everyone. The ballots are siloed per-team via RLS so non-commish
-- managers can see their own vote + whether one exists, but not what
-- anyone else picked or the running tally.
-- Re-runnable.

create table if not exists public.league_votes (
  vote_id       text not null,
  team_id       text not null,
  option_index  integer not null,
  voted_at      timestamptz not null default now(),
  user_id       uuid references auth.users(id),
  primary key (vote_id, team_id)
);

alter table public.league_votes enable row level security;

drop policy if exists "lv_select_own_or_admin" on public.league_votes;
drop policy if exists "lv_insert_own"          on public.league_votes;
drop policy if exists "lv_update_own"          on public.league_votes;
drop policy if exists "lv_delete_admin"        on public.league_votes;

-- Read: see your own ballot OR see everything if you're a commissioner.
create policy "lv_select_own_or_admin"
  on public.league_votes for select
  using (team_id = public.my_team_id() or public.is_commissioner());

-- Insert: only as your own team.
create policy "lv_insert_own"
  on public.league_votes for insert
  with check (
    auth.role() = 'authenticated'
    and team_id = public.my_team_id()
  );

-- Update: change your own vote before the close.
create policy "lv_update_own"
  on public.league_votes for update
  using (team_id = public.my_team_id())
  with check (team_id = public.my_team_id());

-- Delete: commissioner only (clear out a stuck row, etc.).
create policy "lv_delete_admin"
  on public.league_votes for delete
  using (public.is_commissioner());

grant select, insert, update on public.league_votes to authenticated;
grant delete on public.league_votes to authenticated; -- gated by RLS to commish
grant all on public.league_votes to service_role;

-- Realtime: commissioners need to see ballots stream in. Others get no
-- update via this channel because RLS filters the broadcast — Supabase
-- realtime applies the same policies as a SELECT before pushing.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='league_votes'
  ) then
    alter publication supabase_realtime add table public.league_votes;
  end if;
end $$;
