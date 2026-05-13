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

-- 4. Schedule entries. Times are UTC. Cadence matches .github/workflows/*.
--    Unschedule before scheduling so this script is re-runnable.
select cron.unschedule('league-espn-sync')    where exists (select 1 from cron.job where jobname='league-espn-sync');
select cron.unschedule('league-draft-clock')  where exists (select 1 from cron.job where jobname='league-draft-clock');
select cron.unschedule('league-sheets-sync')  where exists (select 1 from cron.job where jobname='league-sheets-sync');
select cron.unschedule('league-nightly-sync') where exists (select 1 from cron.job where jobname='league-nightly-sync');
select cron.unschedule('league-daily-report') where exists (select 1 from cron.job where jobname='league-daily-report');

select cron.schedule('league-espn-sync',    '*/15 * * * *', $$select public.dispatch_github_workflow('espn-sync.yml');$$);
select cron.schedule('league-draft-clock',  '*/5 * * * *',  $$select public.dispatch_github_workflow('draft-clock.yml');$$);
select cron.schedule('league-sheets-sync',  '*/5 * * * *',  $$select public.dispatch_github_workflow('sheets-sync.yml');$$);
select cron.schedule('league-nightly-sync', '7 8 * * *',    $$select public.dispatch_github_workflow('nightly-sync.yml');$$);
select cron.schedule('league-daily-report', '7 1 * * *',    $$select public.dispatch_github_workflow('daily-report.yml');$$);

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
