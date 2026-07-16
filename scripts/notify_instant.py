#!/usr/bin/env python3
"""
Instant notification poller. Runs every minute via cron.

Reads activity_log rows newer than the last-seen timestamp (tracked in
league_state.notify_marker), classifies each into a notification category,
and dispatches:

  - Email (subject + body) to any team whose notification_prefs has
    prefs[cat].email == "instant" (or receive_all == true).
  - Web Push to any push_subscription belonging to a team whose
    prefs[cat].push == true (or receive_all).

After successful processing, advances the marker to the newest activity_log
created_at timestamp it saw.

Reads scripts/.env for:
  - SUPABASE_SERVICE_ROLE_KEY
  - SMTP_USER / SMTP_PASS (Gmail App Password)
  - VAPID_PRIVATE_KEY / VAPID_SUBJECT (only required if push is in use)
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (
    SUPABASE_URL, APP_URL,
    load_env, fetch_activity_since, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, fetch_push_subs, fetch_league_state_row,
    upsert_league_state_row, event_category, describe_activity, team_name, parse_ts,
)
from _email_template import render_alert
from _mail import send_email
from _push import send_push, to_subscription_info, is_gone


MARKER_KEY = "notify_marker"


# Per-category email subject + URL builder.
CATEGORY_META = {
    "trade_proposal":   {"subject_prefix": "Trade proposal",     "url": APP_URL + "?tab=trades&sub=inbox", "title": "Trade proposal", "tag": "PROPOSAL"},
    "trade_update":     {"subject_prefix": "Trade update",       "url": APP_URL + "?tab=trades&sub=inbox", "title": "Trade update",    "tag": "UPDATE"},
    "trade_message":    {"subject_prefix": "New trade message",  "url": APP_URL + "?tab=trades&sub=inbox", "title": "New message",     "tag": "MESSAGE"},
    "trade_completed":  {"subject_prefix": "Trade completed",    "url": APP_URL + "?tab=trades&sub=log",   "title": "Trade completed", "tag": "TRADE"},
    # League votes — initiated + ended events email commissioners only.
    "league_vote":      {"subject_prefix": "League vote",        "url": APP_URL + "?tab=rules",            "title": "League vote",     "tag": "VOTE"},
    # Commish-broadcast vote result — emails the whole league with totals
    # only. No voter names in the body.
    "vote_result":      {"subject_prefix": "League vote result", "url": APP_URL + "?tab=rules",            "title": "League vote result", "tag": "VOTE"},
}


def recipients_for_activity(activity, all_prefs, channel, commish_team_ids=None,
                            all_team_ids=None):
    """Return list of team_ids that should be notified for this event on
    the given channel ('email' or 'push'). Builds a small set keyed by team_id
    so each recipient gets at most one notification per event.

    commish_team_ids: set of team_ids whose owners are flagged commissioner
    (used for vote_* events which fan out to commissioners only).
    all_team_ids: every team in the league (from the owners fetch) — used for
    league-wide fan-outs so teams that never saved notification settings
    still get their defaults (a missing prefs row ≠ opted out).
    """
    a = activity
    cat = event_category(a.get("type"))
    if not cat: return []
    payload = a.get("payload") or {}
    actor = a.get("actor_team_id")
    target = a.get("target_team_id")
    commish_team_ids = commish_team_ids or set()
    all_team_ids = all_team_ids or set()

    # Determine "candidate" recipients per event type. The recipient is
    # whoever is meaningfully affected; receive_all flag overrides this and
    # ALWAYS includes that team.
    candidates = set()
    t = a.get("type")
    if t == "proposal_created":
        if target: candidates.add(target)
    elif t in ("proposal_accepted", "proposal_rejected", "proposal_withdrawn", "proposal_countered"):
        # Notify the other party.
        if target: candidates.add(target)
        if actor:  candidates.add(actor)
    elif t in ("proposal_message_sent", "trade_message"):
        # Recipient is the other side of the thread (not actor).
        if target: candidates.add(target)
    elif t == "trade_recorded":
        # trade_completed is league-wide.
        for team_id in (all_prefs or {}).keys():
            candidates.add(team_id)
        # Make sure trade parties are included even if they have no prefs row.
        if payload.get("team1"): candidates.add(payload["team1"])
        if payload.get("team2"): candidates.add(payload["team2"])
    elif t in ("vote_initiated", "vote_ended"):
        # League votes — commissioners only.
        for tid in commish_team_ids:
            candidates.add(tid)
    elif t == "vote_result_broadcast":
        # Commish-triggered league-wide announcement — fan out to EVERY team
        # in the league, not just teams with a notification_prefs row: a
        # missing row means the app.js defaults apply (email instant + push).
        for team_id in (all_team_ids or (all_prefs or {}).keys()):
            candidates.add(team_id)
        # Also include the actor so they get a confirmation copy even if
        # their team has no notify_prefs row yet.
        if actor: candidates.add(actor)
    else:
        # For keeper_* / rule5_* / callup / send_down / draft picks etc., the
        # "candidate" pool is the actor team (their own actions don't notify
        # them — actors are filtered out below) plus everyone with receive_all.
        # We don't notify everyone, since these are digest-only categories per
        # spec — but we ALSO leak them as digest events.
        pass

    # Always add receive_all teams.
    for tid, row in (all_prefs or {}).items():
        if row.get("receive_all"):
            candidates.add(tid)

    # Filter by pref + channel.
    out = []
    # vote_result is the one category where the actor (the commish who hit
    # "Send result to league") should ALSO get the email — it's their
    # confirmation that the league email went out. Other categories follow
    # the normal "skip actor" rule.
    skip_actor = (a.get("type") != "vote_result_broadcast")
    for tid in candidates:
        if tid == actor and skip_actor:
            # Don't notify the actor about their own action.
            continue
        # League vote events: commissioners get them unconditionally on
        # email regardless of prefs (this is a league-business notification,
        # not a routine alert). Push still respects opt-in.
        if cat == "league_vote" and channel == "email" and tid in commish_team_ids:
            out.append(tid); continue
        row = (all_prefs or {}).get(tid) or {}
        if row.get("receive_all"):
            out.append(tid); continue
        prefs = row.get("prefs") or {}
        cur = prefs.get(cat) or {}
        # vote_result defaults to "instant" email + push true when no pref
        # is set (matches NOTIFY_EVENTS defaults in app.js) — the UI offers
        # only Instant or Never (opt-out) and most users won't have toggled
        # it off.
        if cat == "vote_result" and channel == "email" and cur.get("email") in (None, "instant"):
            out.append(tid); continue
        if cat == "vote_result" and channel == "push" and cur.get("push") in (None, True):
            out.append(tid); continue
        if channel == "email" and cur.get("email") == "instant":
            out.append(tid)
        elif channel == "push" and cur.get("push"):
            out.append(tid)
    return out


def main():
    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    vapid_priv = (env.get("VAPID_PRIVATE_KEY") or "").replace("\\n", "\n")
    vapid_sub  = env.get("VAPID_SUBJECT") or "mailto:jwarshafsky@gmail.com"
    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr); sys.exit(1)

    marker = fetch_league_state_row(key, MARKER_KEY) or {}
    since_iso = marker.get("last_seen_ts")
    if not since_iso:
        # First run: only look at the last hour to avoid spam-blasting old events.
        from datetime import timedelta
        since_iso = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

    activity = fetch_activity_since(key, since_iso=since_iso, limit=500) or []
    if not activity:
        print("No new activity.")
        return

    # Skip events we already processed. The fetch is >= so rows sharing the
    # marker's exact created_at aren't lost when a 500-row page ends on that
    # timestamp — the marker carries the ids seen AT that timestamp and we
    # skip just those. Old-format markers (timestamp only, no id list) fall
    # back to the strict > filter for that one run.
    prev_ts = marker.get("last_seen_id_ts") or since_iso
    has_id_list = "last_seen_ids" in marker
    prev_ids = set(marker.get("last_seen_ids") or [])
    def _is_new(a):
        ts = a.get("created_at") or ""
        if ts > prev_ts: return True
        if ts == prev_ts and has_id_list: return a.get("id") not in prev_ids
        return False
    activity = [a for a in activity if _is_new(a)]
    if not activity:
        print("No new activity after marker.")
        return

    owners = fetch_all_owners(key) or []
    emails_by_uid = fetch_emails_by_user_id(key)
    # Email per team — prefer the explicit row email, else look up via owners.
    all_prefs = fetch_notify_prefs(key)
    # Set of team_ids whose owners are commissioners (used for vote events).
    commish_team_ids = {o["team_id"] for o in owners if o.get("is_commissioner") and o.get("team_id")}
    # Every team in the league — league-wide fan-outs must include teams that
    # never saved notification settings (they get the app.js defaults).
    all_team_ids = {o["team_id"] for o in owners if o.get("team_id")}
    push_subs = fetch_push_subs(key)
    push_by_team = {}
    for s in push_subs:
        push_by_team.setdefault(s["team_id"], []).append(s)
    # Each team may have multiple managers (co-managers like Josh/Doug).
    # Build a set of email addresses per team so notifications fan out to
    # every owner record. The team-level prefs.email row, if set, is a
    # broadcast address that goes to everyone in addition.
    emails_by_team = {}
    for o in owners:
        addr = emails_by_uid.get(o["id"])
        if addr:
            emails_by_team.setdefault(o["team_id"], set()).add(addr)
    for tid, row in (all_prefs or {}).items():
        broadcast = row.get("email")
        if broadcast:
            emails_by_team.setdefault(tid, set()).add(broadcast)

    email_sent = 0
    push_sent = 0
    push_failed_endpoints = []
    failed_events = []  # (created_at, id) of events with a transient delivery failure
    for a in activity:
        cat = event_category(a.get("type"))
        meta = CATEGORY_META.get(cat) if cat else None
        if not meta:
            continue  # Not an "instant"-eligible category (those are digest-only).
        headline = describe_activity(a)
        event_failed = False  # any transient send failure holds the marker for retry
        # Email — fan out to every manager on the team.
        targets = recipients_for_activity(a, all_prefs, "email", commish_team_ids, all_team_ids)
        for tid in targets:
            addrs = emails_by_team.get(tid) or set()
            if not addrs: continue
            subject = f"The League: {meta['subject_prefix']} — {team_name(a.get('actor_team_id') or '?')}"
            html, text = render_alert(meta["title"], headline, url=meta["url"], cta_label="Open in app")
            for addr in addrs:
                if smtp_user and smtp_pass:
                    try:
                        send_email(smtp_user, smtp_pass, [addr], subject, html, text)
                        email_sent += 1
                    except Exception as e:
                        event_failed = True
                        print(f"  ! email failed for {tid} <{addr}>: {e}", file=sys.stderr)
                else:
                    print(f"[preview email] {tid} <{addr}> — {subject}")
        # Push
        if vapid_priv:
            targets = recipients_for_activity(a, all_prefs, "push", commish_team_ids, all_team_ids)
            payload = {
                "title": f"{meta['tag'].title()}: {team_name(a.get('actor_team_id') or '?')}",
                "body": headline.replace("<strong>", "").replace("</strong>", ""),
                "url": meta["url"],
                "tag": f"the-league-{cat}-{a.get('id', '')}",
            }
            for tid in targets:
                for sub in push_by_team.get(tid, []):
                    try:
                        send_push(to_subscription_info(sub), payload, vapid_priv, vapid_sub)
                        push_sent += 1
                    except Exception as e:
                        if is_gone(e):
                            push_failed_endpoints.append(sub["endpoint"])
                        else:
                            event_failed = True
                            print(f"  ! push failed for {tid}: {e}", file=sys.stderr)

        if event_failed:
            failed_events.append((a.get("created_at") or "", a.get("id")))

    # Prune dead push subs.
    for endpoint in set(push_failed_endpoints):
        try:
            url = f"{SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.{urllib.parse.quote(endpoint, safe='')}"
            req = urllib.request.Request(url, method="DELETE", headers={
                "apikey": key, "Authorization": f"Bearer {key}",
            })
            urllib.request.urlopen(req, timeout=10)
        except Exception:
            pass

    # Advance the marker. Normally to the newest event we saw — but if any event
    # had a transient delivery failure, hold the marker just before the EARLIEST
    # failed event so it (and everything after) is retried next run. A recipient
    # who already got an earlier-in-the-batch alert may see a duplicate; that's
    # the accepted cost of at-least-once delivery vs. silently dropping an alert.
    newest = max((a.get("created_at") or "") for a in activity)
    if failed_events:
        earliest_failure = min(ts for ts, _ in failed_events if ts)
        prior = [ts for ts in ((a.get("created_at") or "") for a in activity) if ts < earliest_failure]
        marker_ts = max(prior) if prior else prev_ts
        print(f"  … {len(failed_events)} event(s) had delivery failures; "
              f"holding marker at {marker_ts} for retry.", file=sys.stderr)
    else:
        marker_ts = newest
    # Record the ids seen at exactly marker_ts so the next run (which fetches
    # >= marker_ts) can skip them without losing any row that shares that
    # timestamp. Failed events are excluded so they retry; if the marker
    # didn't move, carry the previously-seen ids forward too.
    failed_ids = {eid for _, eid in failed_events if eid}
    marker_ids = {a.get("id") for a in activity
                  if (a.get("created_at") or "") == marker_ts
                  and a.get("id") and a.get("id") not in failed_ids}
    if marker_ts == prev_ts and has_id_list:
        marker_ids |= prev_ids
    upsert_league_state_row(key, MARKER_KEY, {
        "last_seen_ts": marker_ts, "last_seen_id_ts": marker_ts,
        "last_seen_ids": sorted(marker_ids),
    })
    print(f"Processed {len(activity)} event(s): {email_sent} email, {push_sent} push, pruned {len(set(push_failed_endpoints))} dead push sub(s).")


if __name__ == "__main__":
    main()
