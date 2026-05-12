#!/usr/bin/env python3
"""
One-shot script to send sample copies of every notification + auth email
to a single recipient. Use it once to see what each template looks like
in your actual inbox.

Reads scripts/.env for SMTP_USER + SMTP_PASS (Gmail App Password).
Recipient defaults to SMTP_USER; pass a different email as the first arg:

  python3 scripts/send_sample_emails.py
  python3 scripts/send_sample_emails.py someone-else@example.com
"""

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import load_env, APP_URL
from _email_template import render_digest, render_alert
from _mail import send_email


def daily_digest():
    sections = [
        {"title": "Trade Proposals", "url": APP_URL + "?tab=trades&sub=inbox", "items": [
            {"headline": "<strong>Matt</strong> sent you a proposal", "sub": "You get Bobby Witt Jr.; they get Bryce Harper + 1st-round 2027 pick", "tag": ("PROPOSAL", "proposal")},
            {"headline": "<strong>Dave</strong> accepted your counter", "sub": "2 hours ago", "tag": ("ACCEPTED", "proposal")},
        ]},
        {"title": "Trade Messages", "url": APP_URL + "?tab=trades&sub=inbox", "items": [
            {"headline": "<strong>Saxton</strong> replied in your thread", "sub": '"I can add $3 in draft dollars if you swap Wyatt for Carroll"', "tag": ("MESSAGE", "message")},
        ]},
        {"title": "Trades Completed", "url": APP_URL + "?tab=trades&sub=log", "items": [
            {"headline": "<strong>Saxton</strong> ↔ <strong>Larry</strong>: Saxton gets Yordan Alvarez; Larry gets Wyatt Langford + $4 draft", "tag": ("TRADE", "trade")},
            {"headline": "<strong>Corey</strong> ↔ <strong>Jesse</strong>: Corey gets 2027 Rd 2 pick; Jesse gets $6 draft", "tag": ("TRADE", "trade")},
        ]},
        {"title": "Roster Moves", "url": APP_URL + "?tab=rosters", "items": [
            {"headline": "<strong>Corey</strong> called up Coby Mayo", "tag": ("CALL-UP", "callup")},
            {"headline": "<strong>Glicksman</strong> sent Jack Leiter back to minors", "tag": ("SEND-DOWN", "send-down")},
        ]},
        {"title": "Keeper Protections", "url": APP_URL + "?tab=eligible", "items": [
            {"headline": "<strong>Jesse</strong> tagged Corbin Carroll as a keeper", "tag": ("KEEPER", "keeper")},
            {"headline": "<strong>Sam</strong> removed Drew Rasmussen as a keeper", "tag": ("KEEPER", "keeper")},
        ]},
        {"title": "Rule 5 Protections", "url": APP_URL + "?tab=eligible", "items": [
            {"headline": "<strong>Zack</strong> Rule 5–protected Bryce Eldridge", "tag": ("RULE 5", "rule5")},
        ]},
        {"title": "Draft Picks", "url": APP_URL + "?tab=draft", "items": [
            {"headline": "<strong>Matt</strong> picked Roki Sasaki (R3.4)", "tag": ("DRAFT", "draft")},
            {"headline": "<strong>Dave</strong> passed at R3.5", "tag": ("DRAFT", "draft")},
        ]},
    ]
    today = datetime.now(timezone.utc).astimezone().strftime("%A, %b %d, %Y")
    return render_digest(
        title="The League — daily digest",
        subtitle=f"Daily digest · {today}",
        sections=sections,
        greeting="Hi Jeff, here's what happened in the league over the last 24 hours.",
    )


def weekly_digest():
    sections = [
        {"title": "Trades Completed", "url": APP_URL + "?tab=trades&sub=log", "items": [
            {"headline": "<strong>Saxton</strong> ↔ <strong>Larry</strong>: Yordan Alvarez for Wyatt Langford + $4 draft", "tag": ("TRADE", "trade")},
            {"headline": "<strong>Jesse</strong> ↔ <strong>Zack</strong>: Aranda for Arozarena", "tag": ("TRADE", "trade")},
            {"headline": "<strong>Glicksman</strong> ↔ <strong>Matt</strong>: 2 picks swapped", "tag": ("TRADE", "trade")},
        ]},
        {"title": "Keeper Protections", "url": APP_URL + "?tab=eligible", "items": [
            {"headline": "11 keeper toggles across the league this week", "sub": "Most active: Jesse (+3), Sam (-2)", "tag": ("KEEPER", "keeper")},
        ]},
        {"title": "Draft Picks", "url": APP_URL + "?tab=draft", "items": [
            {"headline": "23 picks made (Rounds 1–2 complete)", "tag": ("DRAFT", "draft")},
        ]},
        {"title": "Roster Moves", "url": APP_URL + "?tab=rosters", "items": [
            {"headline": "3 call-ups, 2 send-downs", "tag": ("CALL-UP", "callup")},
        ]},
    ]
    label = datetime.now(timezone.utc).astimezone().strftime("week ending %b %d, %Y")
    return render_digest(
        title="The League — weekly digest",
        subtitle=f"Weekly digest · {label}",
        sections=sections,
        greeting="Hi Jeff, here's the league recap for the past 7 days.",
    )


def auth_magic_link_sample():
    """Render the magic-link template with sample values (Supabase variables
    replaced by realistic strings). For preview purposes only — the real one
    is sent by Supabase itself."""
    html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "email-templates", "auth-magic-link.html")
    with open(html_path) as f:
        tmpl = f.read()
    sample = (tmpl
        .replace("{{ .ConfirmationURL }}", "https://jwarshafsky.github.io/the-league/?token=sample-12345")
        .replace("{{ .Token }}", "12345678")
        .replace("{{ .SiteURL }}", "https://jwarshafsky.github.io/the-league/")
    )
    return sample, "Sample magic-link email — sign-in to The League — code 12345678"


def auth_invite_sample():
    html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "email-templates", "auth-invite.html")
    with open(html_path) as f:
        tmpl = f.read()
    sample = (tmpl
        .replace("{{ .ConfirmationURL }}", "https://jwarshafsky.github.io/the-league/?invite=sample")
        .replace("{{ .Email }}", "newteam@example.com")
        .replace("{{ .SiteURL }}", "https://jwarshafsky.github.io/the-league/")
    )
    return sample, "Sample invite email — welcome to The League"


SAMPLES = [
    ("[Sample 1/10] Daily digest (everything-feed)", daily_digest),
    ("[Sample 2/10] Weekly digest", weekly_digest),
    ("[Sample 3/10] Instant — new trade proposal", lambda: render_alert(
        title="New trade proposal",
        body_text="<strong>Matt</strong> sent you a trade proposal: you get Bobby Witt Jr.; they get Bryce Harper + 1st-round 2027 pick.",
        url=APP_URL + "?tab=trades&sub=inbox", cta_label="View in inbox")),
    ("[Sample 4/10] Instant — new trade message", lambda: render_alert(
        title="New trade message",
        body_text='<strong>Saxton</strong> replied: "I can add $3 in draft dollars if you swap Wyatt for Carroll."',
        url=APP_URL + "?tab=trades&sub=inbox", cta_label="Open thread")),
    ("[Sample 5/10] Instant — trade completed", lambda: render_alert(
        title="Trade completed",
        body_text="<strong>Saxton</strong> ↔ <strong>Larry</strong>: Saxton gets Yordan Alvarez; Larry gets Wyatt Langford + $4 draft.",
        url=APP_URL + "?tab=trades&sub=log", cta_label="See trade log")),
    ("[Sample 6/10] Draft — on the clock", lambda: render_alert(
        title="On the clock — R3.4",
        body_text="Your team (<strong>Jeff</strong>) is on the clock for the Minors Draft (Round 3, Pick 4). The 4-hour pick clock is ticking — pauses overnight midnight–8 AM ET.",
        url=APP_URL + "?tab=draft", cta_label="Make my pick")),
    ("[Sample 7/10] Draft — on deck", lambda: render_alert(
        title="On deck — R3.5",
        body_text="Your team (<strong>Jeff</strong>) is on deck for the Minors Draft (Round 3, Pick 5). One pick to go before you're up.",
        url=APP_URL + "?tab=draft", cta_label="Open Minors Draft")),
    ("[Sample 8/10] Draft — in the hole", lambda: render_alert(
        title="In the hole — R3.6",
        body_text="Your team (<strong>Jeff</strong>) is in the hole for the Minors Draft (Round 3, Pick 6). Two picks until you're up.",
        url=APP_URL + "?tab=draft", cta_label="Open Minors Draft")),
    ("[Sample 9/10] Auth — magic link / sign-in", auth_magic_link_sample),
    ("[Sample 10/10] Auth — invite user", auth_invite_sample),
]


def main():
    env = load_env()
    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    if not smtp_user or not smtp_pass:
        print("SMTP_USER / SMTP_PASS not set in scripts/.env", file=sys.stderr); sys.exit(1)
    recipient = sys.argv[1] if len(sys.argv) > 1 else smtp_user
    print(f"Sending 10 sample emails to: {recipient}")
    for label, fn in SAMPLES:
        result = fn()
        if isinstance(result, tuple) and len(result) == 2 and isinstance(result[0], str) and "<html" in result[0].lower():
            html, subject = result
            text = "Open this in an HTML-capable email client to see the design."
        else:
            html, text = result
            subject = label
        try:
            send_email(smtp_user, smtp_pass, [recipient], label, html, text)
            print(f"  sent: {label}")
        except Exception as e:
            print(f"  FAILED: {label} — {e}", file=sys.stderr)
    print("Done.")


if __name__ == "__main__":
    main()
