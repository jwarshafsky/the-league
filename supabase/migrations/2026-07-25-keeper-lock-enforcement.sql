-- 2026-07-25 — Server-side keeper-lock enforcement + league_state.version backfill
--
-- Bug 1 (real bypass): the keeper deadline lock was enforced ONLY in the
-- browser — renderEligibleTable() sets `disabled` and toggleEligibleKeeper()
-- shows a toast, but ks_write_owner has no deadline condition. Any owner with
-- the public anon key and their own JWT could still write keeper_selections
-- after the commissioner locked keepers. Per CLAUDE.md the authorization has to
-- live in the database, not in the code that hides the checkbox.
--
-- Bug 2 (schema drift): league_state.version is declared in schema.sql, but
-- that DDL is `create table if not exists`, so a project created before commit
-- f757b93 never got the column added. save_league_state()'s optimistic
-- concurrency depends on it. This adds it idempotently.
--
-- NOT enforced here, deliberately: the 8-ML / 10-MiL keeper CAP. The cap counts
-- only players who are actually on the team's current ESPN roster AND still
-- keepable next year — neither fact exists in Postgres. keeper_selections
-- legitimately retains rows for players who were traded or dropped (the app
-- filters them out at render time), so a naive `count(*) where keeper` would
-- over-count and falsely block owners who are under the real cap. The cap is
-- therefore enforced client-side, gated on the new `enforceKeeperCap`
-- commissioner setting. Revisit if roster state ever becomes a DB fact.
--
-- Safe to re-run. Run in the Supabase SQL Editor.

alter table public.league_state
  add column if not exists version bigint not null default 0;

-- ---------------------------------------------------------------------------
-- Are keepers locked? Mirrors isKeeperLockoutActive() in js/app.js.
-- The stored shape is { locked: true }; row absent / null state = unlocked.
-- ---------------------------------------------------------------------------
create or replace function public.keepers_locked()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select (state->>'locked')::boolean
       from public.league_state
      where key = 'keeper_deadline'),
    false
  );
$$;

grant execute on function public.keepers_locked() to authenticated;

-- ---------------------------------------------------------------------------
-- Block non-commissioner keeper writes while the lock is on.
-- Commissioners (incl. co-commissioner) keep write access to fix mistakes,
-- which matches the existing UI behavior.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_keeper_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.keeper_selections;
begin
  row_out := case when tg_op = 'DELETE' then old else new end;
  -- Backend contexts (service_role jobs, the RLS negative test's cleanup) have
  -- no auth.uid(). The keeper lock is a rule for MANAGERS; authorization for
  -- these writes is already handled by ks_write_owner, which denies an
  -- unauthenticated client outright. Don't let the lock break maintenance.
  if auth.uid() is null then
    return row_out;
  end if;
  if public.is_commissioner() then
    return row_out;
  end if;
  if public.keepers_locked() then
    raise exception 'Keeper selections are locked by the commissioner'
      using errcode = 'check_violation';
  end if;
  return row_out;
end;
$$;

drop trigger if exists ks_enforce_lock on public.keeper_selections;
create trigger ks_enforce_lock
  before insert or update or delete on public.keeper_selections
  for each row execute function public.enforce_keeper_lock();
