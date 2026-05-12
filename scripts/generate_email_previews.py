#!/usr/bin/env python3
"""
Generate preview HTML files for every kind of notification email the system
sends. Uses the real template code (scripts/_email_template.py) so the
previews stay in sync. Writes to email-templates/preview-*.html.

Usage:
  python3 scripts/generate_email_previews.py
"""

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _email_template import render_digest, render_alert, APP_URL


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(ROOT, "email-templates")


def write(name, html):
    path = os.path.join(OUT_DIR, name)
    with open(path, "w") as f:
        f.write(html)
    print(f"  wrote {os.path.relpath(path, ROOT)}")


def daily_digest():
    sections = [
        {
            "title": "Trade Proposals", "url": APP_URL + "?tab=trades&sub=inbox",
            "items": [
                {"headline": "<strong>Matt</strong> sent you a proposal", "sub": "You get Bobby Witt Jr.; they get Bryce Harper + 1st-round 2027 pick", "tag": ("PROPOSAL", "proposal")},
                {"headline": "<strong>Dave</strong> accepted your counter", "sub": "2 hours ago", "tag": ("ACCEPTED", "proposal")},
            ],
        },
        {
            "title": "Trade Messages", "url": APP_URL + "?tab=trades&sub=inbox",
            "items": [
                {"headline": "<strong>Saxton</strong> replied in your thread", "sub": '"I can add $3 in draft dollars if you swap Wyatt for Carroll"', "tag": ("MESSAGE", "message")},
            ],
        },
        {
            "title": "Trades Completed", "url": APP_URL + "?tab=trades&sub=log",
            "items": [
                {"headline": "<strong>Saxton</strong> ↔ <strong>Larry</strong>: Saxton gets Yordan Alvarez; Larry gets Wyatt Langford + $4 draft", "tag": ("TRADE", "trade")},
                {"headline": "<strong>Corey</strong> ↔ <strong>Jesse</strong>: Corey gets 2027 Rd 2 pick; Jesse gets $6 draft", "tag": ("TRADE", "trade")},
            ],
        },
        {
            "title": "Roster Moves", "url": APP_URL + "?tab=rosters",
            "items": [
                {"headline": "<strong>Corey</strong> called up Coby Mayo", "tag": ("CALL-UP", "callup")},
                {"headline": "<strong>Glicksman</strong> sent Jack Leiter back to minors", "tag": ("SEND-DOWN", "send-down")},
            ],
        },
        {
            "title": "Keeper Protections", "url": APP_URL + "?tab=eligible",
            "items": [
                {"headline": "<strong>Jesse</strong> tagged Corbin Carroll as a keeper", "tag": ("KEEPER", "keeper")},
                {"headline": "<strong>Sam</strong> removed Drew Rasmussen as a keeper", "tag": ("KEEPER", "keeper")},
                {"headline": "<strong>AJ</strong> tagged Pete Crow-Armstrong as a keeper", "tag": ("KEEPER", "keeper")},
            ],
        },
        {
            "title": "Rule 5 Protections", "url": APP_URL + "?tab=eligible",
            "items": [
                {"headline": "<strong>Zack</strong> Rule 5–protected Bryce Eldridge", "tag": ("RULE 5", "rule5")},
            ],
        },
        {
            "title": "Draft Picks", "url": APP_URL + "?tab=draft",
            "items": [
                {"headline": "<strong>Matt</strong> picked Roki Sasaki (R3.4)", "tag": ("DRAFT", "draft")},
                {"headline": "<strong>Dave</strong> passed at R3.5", "tag": ("DRAFT", "draft")},
            ],
        },
    ]
    today = datetime.now(timezone.utc).astimezone().strftime("%A, %b %d, %Y")
    html, _ = render_digest(
        title="The League — daily digest",
        subtitle=f"Daily digest · {today}",
        sections=sections,
        greeting="Hi Jeff, here's what happened in the league over the last 24 hours.",
    )
    write("preview-digest-daily.html", html)


def weekly_digest():
    sections = [
        {
            "title": "Trades Completed", "url": APP_URL + "?tab=trades&sub=log",
            "items": [
                {"headline": "<strong>Saxton</strong> ↔ <strong>Larry</strong>: Yordan Alvarez for Wyatt Langford + $4 draft", "tag": ("TRADE", "trade")},
                {"headline": "<strong>Jesse</strong> ↔ <strong>Zack</strong>: Aranda for Arozarena", "tag": ("TRADE", "trade")},
                {"headline": "<strong>Glicksman</strong> ↔ <strong>Matt</strong>: 2 picks swapped", "tag": ("TRADE", "trade")},
            ],
        },
        {
            "title": "Keeper Protections", "url": APP_URL + "?tab=eligible",
            "items": [
                {"headline": "11 keeper toggles across the league this week", "sub": "Most active: Jesse (+3), Sam (-2)", "tag": ("KEEPER", "keeper")},
            ],
        },
        {
            "title": "Draft Picks", "url": APP_URL + "?tab=draft",
            "items": [
                {"headline": "23 picks made (Rounds 1–2 complete)", "tag": ("DRAFT", "draft")},
            ],
        },
        {
            "title": "Roster Moves", "url": APP_URL + "?tab=rosters",
            "items": [
                {"headline": "3 call-ups, 2 send-downs", "tag": ("CALL-UP", "callup")},
            ],
        },
    ]
    label = datetime.now(timezone.utc).astimezone().strftime("week ending %b %d, %Y")
    html, _ = render_digest(
        title="The League — weekly digest",
        subtitle=f"Weekly digest · {label}",
        sections=sections,
        greeting="Hi Jeff, here's the league recap for the past 7 days.",
    )
    write("preview-digest-weekly.html", html)


def instant_trade_proposal():
    html, _ = render_alert(
        title="New trade proposal",
        body_text="<strong>Matt</strong> sent you a trade proposal: you get Bobby Witt Jr.; they get Bryce Harper + 1st-round 2027 pick.",
        url=APP_URL + "?tab=trades&sub=inbox",
        cta_label="View in inbox",
    )
    write("preview-instant-trade-proposal.html", html)


def instant_trade_message():
    html, _ = render_alert(
        title="New trade message",
        body_text='<strong>Saxton</strong> replied: "I can add $3 in draft dollars if you swap Wyatt for Carroll."',
        url=APP_URL + "?tab=trades&sub=inbox",
        cta_label="Open thread",
    )
    write("preview-instant-trade-message.html", html)


def instant_trade_completed():
    html, _ = render_alert(
        title="Trade completed",
        body_text="<strong>Saxton</strong> ↔ <strong>Larry</strong>: Saxton gets Yordan Alvarez; Larry gets Wyatt Langford + $4 draft.",
        url=APP_URL + "?tab=trades&sub=log",
        cta_label="See trade log",
    )
    write("preview-instant-trade-completed.html", html)


def draft_clock_on_clock():
    html, _ = render_alert(
        title="On the clock — R3.4",
        body_text="Your team (<strong>Jeff</strong>) is on the clock for the Minors Draft (Round 3, Pick 4). The 4-hour pick clock is ticking — pauses overnight midnight–8 AM ET.",
        url=APP_URL + "?tab=draft",
        cta_label="Make my pick",
    )
    write("preview-draft-on-clock.html", html)


def draft_clock_on_deck():
    html, _ = render_alert(
        title="On deck — R3.5",
        body_text="Your team (<strong>Jeff</strong>) is on deck for the Minors Draft (Round 3, Pick 5). One pick to go before you're up.",
        url=APP_URL + "?tab=draft",
        cta_label="Open Minors Draft",
    )
    write("preview-draft-on-deck.html", html)


def draft_clock_in_hole():
    html, _ = render_alert(
        title="In the hole — R3.6",
        body_text="Your team (<strong>Jeff</strong>) is in the hole for the Minors Draft (Round 3, Pick 6). Two picks until you're up.",
        url=APP_URL + "?tab=draft",
        cta_label="Open Minors Draft",
    )
    write("preview-draft-in-hole.html", html)


def index_page():
    items = [
        ("Daily digest (Jeff's everything-feed)", "preview-digest-daily.html"),
        ("Weekly digest", "preview-digest-weekly.html"),
        ("Instant: new trade proposal", "preview-instant-trade-proposal.html"),
        ("Instant: new trade message", "preview-instant-trade-message.html"),
        ("Instant: trade completed", "preview-instant-trade-completed.html"),
        ("Draft alert: on the clock", "preview-draft-on-clock.html"),
        ("Draft alert: on deck", "preview-draft-on-deck.html"),
        ("Draft alert: in the hole", "preview-draft-in-hole.html"),
        ("Magic link (Supabase auth)", "auth-magic-link.html"),
        ("Invite user (Supabase auth)", "auth-invite.html"),
    ]
    rows = "\n".join(
        f'<li style="margin:6px 0"><a href="{href}" style="color:#1e40af;text-decoration:none;font-weight:600">{label}</a></li>'
        for label, href in items
    )
    html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>The League — email previews</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#e2e8f0;color:#0f172a;padding:36px 24px;margin:0">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 16px rgba(15,23,42,0.08)">
    <h1 style="margin:0 0 6px;font-size:22px;color:#0f172a">The League — email previews</h1>
    <p style="color:#64748b;font-size:14px;margin:0 0 18px">Click any link to see exactly what that email will look like.</p>
    <ul style="list-style:none;padding:0;margin:0;font-size:15px">{rows}</ul>
  </div>
</body></html>"""
    write("index.html", html)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("Generating email previews:")
    daily_digest()
    weekly_digest()
    instant_trade_proposal()
    instant_trade_message()
    instant_trade_completed()
    draft_clock_on_clock()
    draft_clock_on_deck()
    draft_clock_in_hole()
    index_page()
    print("Done.")


if __name__ == "__main__":
    main()
