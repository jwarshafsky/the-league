-- Harden lm_insert_own: an owner posting to the message board may stamp a
-- user_id only if it's their own. Previously the policy checked team_id but not
-- user_id, so a signed-in owner could insert (via direct REST) a message row
-- carrying ANOTHER user's user_id. Team attribution can't be spoofed (the UI
-- keys display off team_id), but delete rights key off user_id = auth.uid()
-- (lm_delete_admin), so a forged user_id transfers delete ability to the named
-- victim and away from the real author. Re-runnable.

drop policy if exists "lm_insert_own" on public.league_messages;

create policy "lm_insert_own"
  on public.league_messages for insert
  with check (
    team_id = public.my_team_id()
    and (user_id is null or user_id = auth.uid())
  );
