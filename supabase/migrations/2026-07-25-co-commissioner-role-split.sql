-- 2026-07-25 — Co-commissioner role split (Jeff-confirmed spec, 2026-07-17)
--
-- Problem: owners.is_commissioner is a single boolean gating EVERYTHING —
-- constitution/settings edits, snapshot restore, invite management, salary
-- overrides, trade recording, votes, activity deletes AND visibility into
-- every team's private pending trade negotiations. Dave is co-commissioner
-- intentionally, but he also competes in the league, so the last item is a
-- competitive-information leak. Surfaced in the sandbox trial when Dave's
-- Trade Inbox listed four pending negotiations between other teams.
--
-- Spec: co-commissioner keeps FULL admin. The ONE exclusion is visibility into
-- other teams' PENDING private trade negotiations. Completed/recorded trades
-- stay league-visible exactly as today.
--
-- Implementation: add a second flag for the head commissioner (Jeff) and
-- re-gate ONLY the trade-proposal surfaces on it. Everything else continues to
-- use is_commissioner() unchanged.
--
-- Safe to re-run. Run in the Supabase SQL Editor.

alter table public.owners
  add column if not exists is_head_commissioner boolean not null default false;

update public.owners
   set is_head_commissioner = true
 where team_id = 'jeff' and is_commissioner;

create or replace function public.is_head_commissioner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_head_commissioner from public.owners where id = auth.uid()),
    false
  );
$$;

grant execute on function public.is_head_commissioner() to authenticated;


-- ---------------------------------------------------------------------------
-- Protect the flag itself. owners_update_admin is `using (is_commissioner())`
-- with no column restriction, so without this a CO-commissioner could simply
-- PATCH their own owners row with {"is_head_commissioner": true} and re-grant
-- themselves every private negotiation this migration just hid — defeating the
-- whole split. Only an existing head commissioner (or a backend/service-role
-- context, which has no auth.uid()) may change the flag, in either direction:
-- demoting the head commissioner is an attack too.
-- ---------------------------------------------------------------------------
create or replace function public.guard_head_commissioner_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_head_commissioner is distinct from old.is_head_commissioner
     and auth.uid() is not null
     and not public.is_head_commissioner() then
    raise exception 'Only the head commissioner can change is_head_commissioner'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists owners_guard_head_flag on public.owners;
create trigger owners_guard_head_flag
  before update on public.owners
  for each row execute function public.guard_head_commissioner_flag();

-- ---------------------------------------------------------------------------
-- trade_proposals — private to the two parties + head commissioner.
-- ---------------------------------------------------------------------------
drop policy if exists "tp_select_party" on public.trade_proposals;
create policy "tp_select_party"
  on public.trade_proposals for select
  using (
    public.is_head_commissioner()
    or from_team_id = public.my_team_id()
    or to_team_id   = public.my_team_id()
  );

drop policy if exists "tp_update_party" on public.trade_proposals;
create policy "tp_update_party"
  on public.trade_proposals for update
  using (
    public.is_head_commissioner()
    or from_team_id = public.my_team_id()
    or to_team_id   = public.my_team_id()
  )
  with check (
    public.is_head_commissioner()
    or from_team_id = public.my_team_id()
    or to_team_id   = public.my_team_id()
  );

drop policy if exists "tp_delete_admin" on public.trade_proposals;
-- DELETE stays with ALL commissioners: removing a stuck/abusive row is
-- moderation, not visibility, and the spec keeps every other admin power with
-- the co-commissioner. (They still can't SELECT third-party rows, so this is
-- only reachable for a proposal they already know about.)
create policy "tp_delete_admin"
  on public.trade_proposals for delete
  using (public.is_commissioner());

-- ---------------------------------------------------------------------------
-- trade_proposal_messages — same privacy boundary as the proposals.
-- tpm_insert_self already requires being a party; left unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists "tpm_select_party" on public.trade_proposal_messages;
create policy "tpm_select_party"
  on public.trade_proposal_messages for select
  using (
    public.is_head_commissioner()
    or exists (
      select 1 from public.trade_proposals tp
      where tp.thread_id = trade_proposal_messages.thread_id
        and (tp.from_team_id = public.my_team_id() or tp.to_team_id = public.my_team_id())
    )
  );

drop policy if exists "tpm_delete_admin" on public.trade_proposal_messages;
create policy "tpm_delete_admin"
  on public.trade_proposal_messages for delete
  using (public.is_commissioner());

-- ---------------------------------------------------------------------------
-- activity_log — close the side channel the new proposal events would open.
--
-- 2026-07-25-proposal-activity-events.sql starts emitting proposal_* rows whose
-- payload carries the player names in the deal. al_select_all previously let
-- ANY authenticated user read every activity row, which would hand a
-- co-commissioner (or any owner) exactly the negotiation details the policies
-- above are hiding. Restrict proposal_* rows to the two parties + head commish.
-- Every other event type keeps league-wide visibility, unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists "al_select_all" on public.activity_log;
create policy "al_select_all"
  on public.activity_log for select
  using (
    auth.role() = 'authenticated'
    and (
      type not like 'proposal\_%'
      or public.is_head_commissioner()
      or actor_team_id  = public.my_team_id()
      or target_team_id = public.my_team_id()
    )
  );
