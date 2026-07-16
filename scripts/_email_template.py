# Shared email-rendering helpers used by daily_report.py, weekly_report.py,
# and notify_instant.py. Produces an HTML body matching the digest mockup at
# email-templates/digest-preview.html (logo + dark-blue header + light body +
# grouped sections + "Manage notifications" footer).
#
# Public:
#   render_digest(title, subtitle, sections) -> (html, text)
#   render_alert(title, body, url, cta_label) -> (html, text)
#
# A "section" is { "title": str, "url": str, "items": [{ "headline": str,
# "sub": str (optional), "tag": (label, color) (optional) }] }.

from html import escape


APP_URL = "https://jwarshafsky.github.io/the-league/"
LOGO_URL = "https://jwarshafsky.github.io/the-league/icons/icon-192.png"

ACCENT_DARK = "#1e40af"
ACCENT_DEEP = "#1e3a5f"
TEXT_PRIMARY = "#0f172a"
TEXT_MUTED = "#475569"
TEXT_DIM = "#64748b"
BORDER = "#e2e8f0"
CANVAS = "#e2e8f0"
CARD = "#ffffff"
PANEL = "#f8fafc"
FOOTER_BG = "#f1f5f9"

# Tag color map — keyed by a category string. Add new entries as needed.
TAG_STYLES = {
    "trade":         ("#dbeafe", "#1d4ed8"),
    "proposal":      ("#fef3c7", "#a16207"),
    "message":       ("#e0e7ff", "#3730a3"),
    "callup":        ("#dcfce7", "#15803d"),
    "send-down":     ("#fee2e2", "#b91c1c"),
    "keeper":        ("#fce7f3", "#9d174d"),
    "rule5":         ("#fae8ff", "#7e22ce"),
    "draft":         ("#cffafe", "#0e7490"),
    "settings":      ("#e2e8f0", "#334155"),
    "default":       ("#e2e8f0", "#334155"),
}


def _escape_keep_strong(s):
    """Escape user-supplied text (player names, vote titles, payload fields)
    while preserving the <strong> emphasis markup that describe_activity /
    reminder bodies emit deliberately. Everything else is neutralized."""
    s = escape(s or "")
    return s.replace("&lt;strong&gt;", "<strong>").replace("&lt;/strong&gt;", "</strong>")


def _tag_html(tag):
    if not tag:
        return ""
    label, key = tag if isinstance(tag, tuple) else (str(tag), "default")
    bg, fg = TAG_STYLES.get(key, TAG_STYLES["default"])
    return (
        f'<span style="display:inline-block;background:{bg};color:{fg};'
        f'font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;'
        f'letter-spacing:0.4px;margin-right:8px;text-transform:uppercase;">'
        f'{escape(label)}</span>'
    )


def _section_html(section):
    items = section.get("items") or []
    if not items:
        return ""
    url = section.get("url") or APP_URL
    title = section.get("title") or "Activity"
    rows = []
    for i, item in enumerate(items):
        last = i == len(items) - 1
        border = "" if last else f"border-bottom:1px solid {BORDER};"
        sub = item.get("sub") or ""
        sub_html = f'<div style="font-size:12px;color:{TEXT_DIM};margin-top:3px;line-height:1.4">{escape(sub)}</div>' if sub else ""
        rows.append(
            f'<tr><td style="padding:12px 14px;{border}">'
            f'{_tag_html(item.get("tag"))}'
            f'<span style="font-size:14px;color:{TEXT_PRIMARY};line-height:1.4">{_escape_keep_strong(item["headline"])}</span>'
            f'{sub_html}'
            f'</td></tr>'
        )
    return (
        f'<tr><td style="padding:18px 28px 6px 28px">'
        f'<a href="{escape(url)}" style="text-decoration:none;color:{ACCENT_DARK};font-size:13px;'
        f'font-weight:700;letter-spacing:0.6px;text-transform:uppercase">{escape(title)} →</a>'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="background:{PANEL};border:1px solid {BORDER};border-radius:8px;margin-top:8px">'
        + "".join(rows) +
        f'</table></td></tr>'
    )


def _wrap_layout(title, subtitle, body_html, footer_html=None):
    footer_html = footer_html or (
        f'<a href="{APP_URL}" style="display:inline-block;background:{ACCENT_DARK};color:#ffffff;'
        f'text-decoration:none;font-size:13px;font-weight:600;padding:9px 18px;border-radius:6px">'
        f'Open The League</a>'
    )
    return (
        '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<title>{escape(title)}</title></head>'
        f'<body style="margin:0;padding:0;background:{CANVAS};'
        f'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
        f'color:{TEXT_PRIMARY}">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="background:{CANVAS};padding:24px 12px"><tr><td align="center">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" '
        f'style="max-width:600px;width:100%;background:{CARD};border-radius:12px;overflow:hidden;'
        f'box-shadow:0 4px 16px rgba(15,23,42,0.08)">'
        # Header
        f'<tr><td style="background:linear-gradient(135deg,{ACCENT_DARK},{ACCENT_DEEP});'
        f'padding:24px 28px;color:#ffffff">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
        f'<td valign="middle" style="width:48px">'
        f'<img src="{LOGO_URL}" alt="The League" width="40" height="40" '
        f'style="display:block;border-radius:8px"></td>'
        f'<td valign="middle" style="padding-left:14px">'
        f'<div style="font-size:18px;font-weight:700;letter-spacing:0.2px">The League</div>'
        f'<div style="font-size:13px;color:rgba(255,255,255,0.78);margin-top:2px">{escape(subtitle)}</div>'
        f'</td></tr></table></td></tr>'
        # Body
        f'{body_html}'
        # Footer
        f'<tr><td style="padding:24px 28px;background:{FOOTER_BG};border-top:1px solid {BORDER}">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
        f'<td>{footer_html}</td>'
        f'<td align="right" style="font-size:11px;color:{TEXT_DIM};line-height:1.6">'
        f"Don't want these emails?<br>"
        f'<a href="{APP_URL}?tab=user-settings" style="color:{ACCENT_DARK};text-decoration:underline">'
        f'Manage your notification preferences</a></td></tr></table></td></tr>'
        f'</table>'
        f'<div style="font-size:11px;color:{TEXT_DIM};margin-top:12px">The League · 12-team keeper · '
        f'<a href="{APP_URL}?tab=user-settings" style="color:{TEXT_DIM}">Preferences</a></div>'
        f'</td></tr></table></body></html>'
    )


def render_digest(title, subtitle, sections, greeting=None):
    """Multi-section digest email."""
    greeting_html = ""
    if greeting:
        greeting_html = (
            f'<tr><td style="padding:22px 28px 6px 28px">'
            f'<div style="font-size:14px;color:{TEXT_MUTED};line-height:1.55">{escape(greeting)}</div>'
            f'</td></tr>'
        )
    body = greeting_html + "".join(_section_html(s) for s in sections)
    html = _wrap_layout(title, subtitle, body)
    # Plain-text fallback for clients that don't render HTML.
    lines = [f"{title}", f"{subtitle}", ""]
    if greeting:
        lines += [greeting, ""]
    for s in sections:
        if not s.get("items"):
            continue
        lines.append(f"{s['title']}")
        for it in s["items"]:
            tag = it.get("tag")
            tag_str = ""
            if tag:
                label = tag[0] if isinstance(tag, tuple) else tag
                tag_str = f"[{label}] "
            from re import sub as _resub
            headline = _resub(r"<[^>]+>", "", it["headline"])
            lines.append(f"  {tag_str}{headline}")
            if it.get("sub"):
                lines.append(f"    {it['sub']}")
        lines.append("")
    lines.append(f"Open: {APP_URL}")
    return html, "\n".join(lines)


def render_alert(title, body_text, url=None, cta_label="View"):
    """One-off instant notification: title + one block of body + a CTA link."""
    url = url or APP_URL
    body = (
        f'<tr><td style="padding:24px 28px 8px 28px">'
        f'<div style="font-size:15px;color:{TEXT_PRIMARY};line-height:1.55">{_escape_keep_strong(body_text)}</div>'
        f'</td></tr>'
        f'<tr><td style="padding:8px 28px 24px 28px">'
        f'<a href="{escape(url)}" style="display:inline-block;background:{ACCENT_DARK};'
        f'color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;'
        f'border-radius:6px">{escape(cta_label)}</a>'
        f'</td></tr>'
    )
    html = _wrap_layout(title, title, body)
    from re import sub as _resub
    plain = _resub(r"<[^>]+>", "", body_text)
    text = f"{title}\n\n{plain}\n\n{cta_label}: {url}\n"
    return html, text
