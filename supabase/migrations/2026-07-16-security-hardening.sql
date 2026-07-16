-- 2026-07-16 security hardening + league_state optimistic concurrency.
-- Run in the Supabase SQL editor. Safe to re-run.

-- ============================================================================
-- 1. Lock down the pg_cron dispatch RPCs.
--    Postgres grants EXECUTE to PUBLIC on new functions by default; the
--    original `revoke ... from anon, authenticated` did not remove that
--    inherited grant, so anyone holding the publishable anon key could
--    dispatch GitHub workflows or forge the pg_cron_heartbeat row
--    (live-confirmed 2026-07-16). pg_cron runs as the function owner and
--    is unaffected.
-- ============================================================================
revoke all on function public.dispatch_github_workflow(text) from public, anon, authenticated;
revoke all on function public.dispatch_espn_sync_if_stale() from public, anon, authenticated;

-- ============================================================================
-- 2. notification_prefs: stop exposing every owner's email to all owners.
--    The client only ever reads its own row (settings, inbox-read state);
--    server scripts use the service role and bypass RLS.
-- ============================================================================
drop policy if exists "np_select_all" on public.notification_prefs;
drop policy if exists "np_select_own" on public.notification_prefs;
create policy "np_select_own"
  on public.notification_prefs for select
  using (team_id = public.my_team_id() or public.is_commissioner());

-- ============================================================================
-- 3. league_state optimistic concurrency (compare-and-swap).
--    The draft-clock cron and browsers both do whole-row read-modify-write;
--    without a version check the loser's write silently erases the winner's
--    (e.g. a submitted draft pick replaced by an auto-pass). Writers call
--    save_league_state with the version they read; a stale version raises
--    a 40001 so the caller re-fetches instead of clobbering.
-- ============================================================================
alter table public.league_state add column if not exists version bigint not null default 0;

create or replace function public.save_league_state(
  p_key text, p_state jsonb, p_expected_version bigint
)
returns bigint
language plpgsql
security invoker              -- RLS (ls_write_admin) still gates writes
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
-- 4. Pin search_path on touch_updated_at (consistency with every other
--    function; not currently exploitable — it is SECURITY INVOKER).
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
