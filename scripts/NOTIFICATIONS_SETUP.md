# Notifications setup

End-to-end checklist for getting email + Web Push working. Follow top to bottom.

## 1. Run the schema additions in Supabase

Open the Supabase SQL editor → paste in the `notification_prefs` and
`push_subscriptions` blocks from `supabase/schema.sql` (search for those
table names — they're near the bottom). Run. Both are idempotent, safe to
re-run.

You should now see the two new tables in the Table Editor.

## 2. SMTP is already configured

If `SMTP_USER` and `SMTP_PASS` are already in `scripts/.env` (used by the
existing `daily_report.py`), nothing else to do. Otherwise:

1. Go to https://myaccount.google.com/apppasswords
2. Generate a 16-char App Password (label it "The League")
3. Add to `scripts/.env`:
   ```
   SMTP_USER=jwarshafsky@gmail.com
   SMTP_PASS=abcd efgh ijkl mnop  # 16 chars, paste-as-is (spaces optional)
   ```

## 3. Generate VAPID keys for Web Push (one time only)

```bash
/usr/bin/python3 -m pip install --user py_vapid cryptography pywebpush
python3 scripts/generate_vapid.py
```

The script prints three values. Add the first two to `scripts/.env`:

```
VAPID_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nM...etc...\n-----END PRIVATE KEY-----\n"
VAPID_SUBJECT="mailto:jwarshafsky@gmail.com"
```

Paste the third (the public key) into `js/app.js`, replacing the
`VAPID_PUBLIC_KEY` constant near the top of the User Settings section.
Commit + push so it ships to all clients.

## 4. Add the cron jobs

Edit your crontab (`crontab -e`) and add:

```cron
# Existing entries (ESPN/stats syncs etc.) — leave alone

# Daily league digest at 9pm
0 21 * * * /usr/bin/python3 /Users/jwars/Desktop/Claude/fantasy-league/scripts/daily_report.py >> /tmp/league-daily.log 2>&1

# Weekly digest Sunday 9pm
0 21 * * 0 /usr/bin/python3 /Users/jwars/Desktop/Claude/fantasy-league/scripts/weekly_report.py >> /tmp/league-weekly.log 2>&1

# Instant emails + pushes every minute
* * * * * /usr/bin/python3 /Users/jwars/Desktop/Claude/fantasy-league/scripts/notify_instant.py >> /tmp/league-instant.log 2>&1

# Draft clock alerts every 2 minutes
*/2 * * * * /usr/bin/python3 /Users/jwars/Desktop/Claude/fantasy-league/scripts/notify_draft_clock.py >> /tmp/league-draftclock.log 2>&1
```

Note: the daily entry replaces the previous `daily_report.py` line (if any).
The new version sends per-team digests and includes Jeff's
"receive_all" feed when his row has that flag set.

## 5. Turn on `receive_all` for Jeff

In Supabase SQL editor:

```sql
insert into public.notification_prefs (team_id, prefs, receive_all, email)
values ('jeff', '{}'::jsonb, true, 'jwarshafsky@gmail.com')
on conflict (team_id) do update set receive_all = true, email = excluded.email;
```

Now Jeff's daily digest contains every league event regardless of category prefs.

## 6. Test

- **Email**: trigger any activity (e.g., toggle a keeper) — within ~1 minute
  the instant script picks it up and sends if any team has it set to "instant".
  Run manually first: `python3 scripts/notify_instant.py` — should print
  "Processed N event(s)" + sender summaries.

- **Push (local test)**: open the app → Settings → click "Enable Push on this
  device" (grant permission) → "Send test notification". You should see the
  notification on your device.

- **Push (server-sent)**: similar to email — trigger an event, run
  `python3 scripts/notify_instant.py`, and a push should arrive on any device
  subscribed for the relevant category.

## Troubleshooting

- `pywebpush not installed`: `pip3 install --user pywebpush`
- `VAPID_PRIVATE_KEY not set`: re-run step 3 and append to `scripts/.env`.
- Notifications work locally but not from cron: check `/tmp/league-instant.log`.
- `permission denied` from Notification API on iOS: PWAs on iOS require the
  app to be added to the Home Screen and opened from there (Safari standalone).
  Regular Safari tabs can't subscribe.
