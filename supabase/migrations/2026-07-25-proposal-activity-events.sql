-- 2026-07-25 — Trade-proposal activity events (CRITICAL fix)
--
-- Bug found by the sandbox trial (2026-07-16 → 07-25): the app never wrote any
-- proposal_* row to activity_log, so the entire instant-alert pipeline for
-- trades had NO PRODUCER. scripts/_notify_db.py:event_category() and
-- notify_instant.py have understood proposal_created / proposal_accepted /
-- proposal_rejected / proposal_withdrawn / proposal_countered /
-- proposal_message_sent since day one, but nothing ever emitted them. The gap
-- was masked in prod because only the commissioner ever filed trades, via the
-- separate trade_recorded event.
--
-- A second layer made the obvious client-side fix impossible: al_insert_self
-- only lets a non-commissioner set target_team_id to another team when
-- type = 'trade_recorded'. Every proposal event inherently targets the
-- counterparty, so client-side logActivityAsync() calls would be rejected by
-- RLS — and logActivityAsync swallows errors, so they would fail silently.
--
-- Fix: write the events SERVER-SIDE from triggers. SECURITY DEFINER bypasses
-- RLS, so no policy has to be loosened (per CLAUDE.md, authorization stays in
-- the database and the client is never trusted for cross-team writes).
--
-- Also fixes: notes were truncated at exactly 200 chars with no ellipsis,
-- cutting mid-sentence in alert bodies. Now 500 + '…'.
--
-- Safe to re-run. Run in the Supabase SQL Editor.

-- ORDERING: run 2026-07-25-co-commissioner-role-split.sql FIRST. That file
-- tightens al_select_all so proposal_* payloads (which carry the deal contents
-- and notes of PENDING negotiations) are readable only by the two parties and
-- the head commissioner. Applying this file alone would publish every team's
-- private offers to any authenticated reader of activity_log.
do $$
begin
  if to_regprocedure('public.is_head_commissioner()') is null then
    raise exception
      'Run 2026-07-25-co-commissioner-role-split.sql first — activity_log would otherwise expose private trade proposals league-wide';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helper: asset arrays are jsonb [{type,value},…]; alerts want the values.
-- ---------------------------------------------------------------------------
create or replace function public.activity_asset_values(assets jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(
    (select jsonb_agg(x->>'value') from jsonb_array_elements(coalesce(assets, '[]'::jsonb)) x),
    '[]'::jsonb
  );
$$;

create or replace function public.activity_truncate(txt text, lim int default 500)
returns text
language sql
immutable
as $$
  select case
    when txt is null then ''
    when length(txt) > lim then left(txt, lim) || '…'
    else txt
  end;
$$;

-- ---------------------------------------------------------------------------
-- trade_proposals → proposal_created / proposal_countered
--                   / proposal_rejected / proposal_withdrawn
--                   (acceptance is covered by the existing trade_recorded event)
-- ---------------------------------------------------------------------------
create or replace function public.log_proposal_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (type, actor_team_id, target_team_id, payload)
    values (
      case when new.parent_proposal_id is null then 'proposal_created'
           else 'proposal_countered' end,
      new.from_team_id,
      new.to_team_id,
      jsonb_build_object(
        'proposal_id',    new.id,
        'thread_id',      new.thread_id,
        'notes',          public.activity_truncate(new.notes),
        'team1',          new.from_team_id,
        'team2',          new.to_team_id,
        'team1_receives', public.activity_asset_values(new.team1_receives),
        'team2_receives', public.activity_asset_values(new.team2_receives)
      )
    );

  -- NOTE: 'accepted' is deliberately NOT here. acceptThreadProposal() already
  -- logs a league-wide trade_recorded event carrying the same deal, so emitting
  -- proposal_accepted too would double-notify the proposer (two emails + two
  -- pushes for one click). It would also strand a phantom event when
  -- acceptProposalAsync rolls the status back to 'pending' after a failed
  -- trades insert — the revert writes no compensating row.
  elsif tg_op = 'UPDATE'
        and new.status is distinct from old.status
        and new.status in ('rejected', 'withdrawn') then
    insert into public.activity_log (type, actor_team_id, target_team_id, payload)
    values (
      'proposal_' || new.status,
      -- reject is performed by the recipient; withdraw by the sender.
      case when new.status = 'withdrawn' then new.from_team_id else new.to_team_id end,
      case when new.status = 'withdrawn' then new.to_team_id   else new.from_team_id end,
      jsonb_build_object(
        'proposal_id',    new.id,
        'thread_id',      new.thread_id,
        'team1',          new.from_team_id,
        'team2',          new.to_team_id,
        'team1_receives', public.activity_asset_values(new.team1_receives),
        'team2_receives', public.activity_asset_values(new.team2_receives)
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists tp_log_activity on public.trade_proposals;
create trigger tp_log_activity
  after insert or update on public.trade_proposals
  for each row execute function public.log_proposal_activity();

-- ---------------------------------------------------------------------------
-- trade_proposal_messages → proposal_message_sent
-- ---------------------------------------------------------------------------
create or replace function public.log_proposal_message_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  other_team text;
begin
  select case when p.from_team_id = new.from_team_id then p.to_team_id
              else p.from_team_id end
    into other_team
    from public.trade_proposals p
   where p.thread_id = new.thread_id
   order by p.created_at desc
   limit 1;

  insert into public.activity_log (type, actor_team_id, target_team_id, payload)
  values (
    'proposal_message_sent',
    new.from_team_id,
    other_team,
    jsonb_build_object(
      'thread_id', new.thread_id,
      'preview',   public.activity_truncate(new.body, 200)
    )
  );
  return new;
end;
$$;

drop trigger if exists tpm_log_activity on public.trade_proposal_messages;
create trigger tpm_log_activity
  after insert on public.trade_proposal_messages
  for each row execute function public.log_proposal_message_activity();

-- ---------------------------------------------------------------------------
-- league_messages → message_posted
--
-- Board posts were structurally unalertable: they live in their own table and
-- never touched activity_log, so event_category() could never see them. This
-- gives them an event. target_team_id stays NULL (league-wide, not directed at
-- anyone), which is what the notifier's fan-out expects.
-- ---------------------------------------------------------------------------
create or replace function public.log_board_message_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.activity_log (type, actor_team_id, target_team_id, payload)
  values (
    'message_posted',
    new.team_id,
    null,
    jsonb_build_object(
      'message_id', new.id,
      'preview',    public.activity_truncate(new.body, 200)
    )
  );
  return new;
end;
$$;

drop trigger if exists lm_log_activity on public.league_messages;
create trigger lm_log_activity
  after insert on public.league_messages
  for each row execute function public.log_board_message_activity();
