-- Allow kind='drop' in roster_moves so the app can record explicit MiL
-- drops (replaces the old "edit the Google Sheet then sync" workflow).
-- Re-runnable.

alter table public.roster_moves
  drop constraint if exists roster_moves_kind_check;

alter table public.roster_moves
  add constraint roster_moves_kind_check
  check (kind in ('callup', 'demote', 'drop'));
