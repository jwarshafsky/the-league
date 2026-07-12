-- ============================================================================
-- Supabase pg_cron fallback for GitHub Actions scheduled workflows.
--
-- GitHub's cron-based scheduler is unreliable — sometimes goes hours without
-- firing scheduled workflows. pg_cron lives inside Supabase Postgres and
-- runs on its own infrastructure. It calls GitHub's workflow_dispatch API to
-- trigger each workflow directly.
--
-- After this is in place: GitHub Actions schedules + pg_cron both fire at
-- their intervals. Whichever wins gets the work done. Each workflow is
-- idempotent (uses markers / overwrites), so double-firing is harmless.
--
-- Run this file once in Supabase SQL editor. After, paste the GitHub PAT
-- into private.app_secrets (instructions at the bottom).
-- ============================================================================

-- 1. Extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. A private schema + table for the GitHub PAT. No RLS, no grants to
--    anon/authenticated — only service_role can read it. The dispatch
--    function runs SECURITY DEFINER so it inherits service-role-level
--    access to this table.
create schema if not exists private;
create table if not exists private.app_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);
revoke all on private.app_secrets from anon, authenticated, public;
grant all on private.app_secrets to service_role;

-- 3. Dispatch helper. Takes a workflow filename (e.g. 'espn-sync.yml')
--    and fires the GitHub workflow_dispatch endpoint for it. Also writes
--    a heartbeat to league_state.pg_cron_heartbeat so the app can detect
--    a pg_cron outage on top of a GitHub-scheduler outage.
create or replace function public.dispatch_github_workflow(workflow_file text)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  pat text;
begin
  select value into pat from private.app_secrets where key = 'github_actions_pat';
  if pat is null then
    raise notice 'pg_cron: no github_actions_pat in private.app_secrets; skipping %', workflow_file;
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/jwarshafsky/the-league/actions/workflows/'
           || workflow_file || '/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Accept', 'application/vnd.github+json',
      'Authorization', 'Bearer ' || pat,
      'User-Agent', 'fantasy-league-pg-cron',
      'X-GitHub-Api-Version', '2022-11-28'
    )
  );

  -- Heartbeat so the app can show "schedulers offline" if pg_cron ALSO stops.
  insert into public.league_state (key, state)
  values ('pg_cron_heartbeat', jsonb_build_object(
    'lastFiredAt', to_jsonb(now()),
    'lastWorkflow', workflow_file
  ))
  on conflict (key) do update set state = jsonb_set(
    jsonb_set(coalesce(public.league_state.state, '{}'::jsonb),
              '{lastFiredAt}', to_jsonb(now())),
    '{lastWorkflow}', to_jsonb(workflow_file)
  );
end;
$$;
revoke all on function public.dispatch_github_workflow(text) from anon, authenticated;

-- 3b. Conditional ESPN-sync fallback. The unconditional high-frequency
--     dispatches were dropped (see section 4) because ~5% of
--     workflow_dispatch-triggered runs hit a transient checkout-auth flake
--     and emailed failure noise. But that left espn-sync with NO fallback:
--     when GitHub's scheduler stalls (it throttled espn-sync to ~hourly and
--     then went 2h dark on 2026-07-11), nothing rescues it. This function
--     dispatches espn-sync ONLY when the last successful sync is >45 min
--     old — a no-op in the normal case (zero extra dispatches, zero flake
--     emails), real coverage during a GitHub scheduler outage.
create or replace function public.dispatch_espn_sync_if_stale()
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  last_success timestamptz;
begin
  select (state->>'lastSuccessAt')::timestamptz into last_success
  from public.league_state
  where key = 'espn_sync_status';

  if last_success is null or now() - last_success > interval '45 minutes' then
    perform public.dispatch_github_workflow('espn-sync.yml');
  end if;
end;
$$;
revoke all on function public.dispatch_espn_sync_if_stale() from anon, authenticated;

-- 4. Schedule entries. Times are UTC. Cadence matches .github/workflows/*.
--    Unschedule before scheduling so this script is re-runnable.
select cron.unschedule('league-espn-sync')     where exists (select 1 from cron.job where jobname='league-espn-sync');
select cron.unschedule('league-draft-clock')   where exists (select 1 from cron.job where jobname='league-draft-clock');
select cron.unschedule('league-sheets-sync')   where exists (select 1 from cron.job where jobname='league-sheets-sync');
select cron.unschedule('league-nightly-sync')  where exists (select 1 from cron.job where jobname='league-nightly-sync');
select cron.unschedule('league-daily-report')  where exists (select 1 from cron.job where jobname='league-daily-report');
select cron.unschedule('league-notify-instant') where exists (select 1 from cron.job where jobname='league-notify-instant');
select cron.unschedule('league-weekly-report') where exists (select 1 from cron.job where jobname='league-weekly-report');
select cron.unschedule('league-key-date-reminders') where exists (select 1 from cron.job where jobname='league-key-date-reminders');
select cron.unschedule('league-heartbeat') where exists (select 1 from cron.job where jobname='league-heartbeat');
select cron.unschedule('league-espn-sync-fallback') where exists (select 1 from cron.job where jobname='league-espn-sync-fallback');

-- High-frequency workflows are dispatched by GitHub's own scheduler only
-- (except the conditional espn-sync rescue below, which stays silent
-- unless the sync actually goes stale).
-- The pg_cron path here was useful when GH's scheduler had multi-hour
-- outages, but the workflow_dispatch token sporadically fails the
-- actions/checkout auth step (transient GH infra issue), which produced
-- ~5% failure emails. Since the GH schedule fires the same work every
-- 5 / 15 min, dropping the pg_cron dispatch eliminates the email noise
-- without changing what actually runs. The .github/workflows/*.yml
-- schedule lines are the source of truth:
--   espn-sync.yml      → */15
--   draft-clock.yml    → */5
--   sheets-sync.yml    → */5
--   notify-instant.yml → */5  (was */1 via pg_cron; acceptable trade)
--
-- Daily / weekly / reminder jobs stay on the pg_cron path because they
-- fire at most ~50 times/day, so the occasional dispatch flake matters
-- less and the GH-schedule fallback is a sturdier safety net for them.
select cron.schedule('league-nightly-sync',  '7 8 * * *',    $$select public.dispatch_github_workflow('nightly-sync.yml');$$);
select cron.schedule('league-daily-report',  '7 1 * * *',    $$select public.dispatch_github_workflow('daily-report.yml');$$);
select cron.schedule('league-weekly-report', '7 1 * * 1',    $$select public.dispatch_github_workflow('weekly-report.yml');$$);
-- Key date reminders fire 1-week and 24-hour ahead. The script tolerates
-- ±3-6h slack so 30-min cadence is plenty.
select cron.schedule('league-key-date-reminders','*/30 * * * *', $$select public.dispatch_github_workflow('key-date-reminders.yml');$$);

-- Heartbeat-only job: bumps league_state.pg_cron_heartbeat every 15 min
-- WITHOUT dispatching anything on GitHub (no PAT use, no dispatch flakes,
-- no failure emails). The app's "Both schedulers offline" banner treats a
-- heartbeat >30 min old as a pg_cron outage — that check is only meaningful
-- if something beats at least every 30 min. Before this job existed, the
-- only frequent beat came from the (removed) high-frequency dispatch jobs,
-- so the heartbeat went stale daily and the banner cried wolf whenever
-- GitHub's scheduler lagged 90+ min.
select cron.schedule('league-heartbeat', '*/15 * * * *', $$
  insert into public.league_state (key, state)
  values ('pg_cron_heartbeat', jsonb_build_object(
    'lastFiredAt', to_jsonb(now()),
    'lastWorkflow', '(heartbeat)'
  ))
  on conflict (key) do update set state = jsonb_set(
    jsonb_set(coalesce(public.league_state.state, '{}'::jsonb),
              '{lastFiredAt}', to_jsonb(now())),
    '{lastWorkflow}', '"(heartbeat)"'::jsonb);
$$);

-- Conditional ESPN-sync rescue (see section 3b): no-op while GitHub's own
-- schedule keeps the sync fresh; dispatches only when the last success is
-- >45 min stale.
select cron.schedule('league-espn-sync-fallback', '*/15 * * * *', $$select public.dispatch_espn_sync_if_stale();$$);

-- ============================================================================
-- NEXT STEP — paste the GitHub PAT (do this AFTER creating it on GitHub):
--   insert into private.app_secrets (key, value)
--   values ('github_actions_pat', 'github_pat_XXXXX')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- PAT creation:
--   GitHub → Settings → Developer settings → Personal access tokens
--   → Fine-grained tokens → Generate new token
--     - Token name: anything (e.g. "League pg_cron")
--     - Expiration: 1 year is fine
--     - Resource owner: your account
--     - Repository access: Only select repositories → jwarshafsky/the-league
--     - Permissions → Repository → Actions: Read and write
--     - Generate token, copy the github_pat_... string
-- ============================================================================
