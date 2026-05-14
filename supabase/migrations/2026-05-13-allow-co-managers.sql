-- Allow multiple users to share a team_id (co-managers like Josh/Doug).
-- The owners.team_id column had a UNIQUE constraint that blocked the
-- second co-manager from claim_invited_team(). Re-runnable.
--
-- Run this in the Supabase SQL Editor.

alter table public.owners
  drop constraint if exists owners_team_id_key;

-- Keep an index for lookups; just not UNIQUE anymore.
create index if not exists owners_team_id_idx on public.owners(team_id);
