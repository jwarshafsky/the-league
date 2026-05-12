# Email templates

Visual previews + paste-ready Supabase auth templates, all matching the same
look (logo + dark blue header + light body + subtle shadow).

## Files

- `digest-preview.html` — sample of what the daily/weekly digest looks like
  (driven by `scripts/_email_template.py` at send time)
- `auth-magic-link.html` — Supabase auth Magic Link / Sign in OTP template
- `auth-invite.html` — Supabase auth Invite User template

## Updating the Supabase auth templates

1. Open the project: https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw
2. Sidebar → **Authentication → Email Templates**
3. Pick the template (Magic Link, Invite User, etc.)
4. Open the corresponding file in this folder, copy the whole thing
5. Paste into the **Body (HTML)** field
6. Save

The templates use Supabase's Go-template variables (`{{ .ConfirmationURL }}`,
`{{ .Token }}`, `{{ .SiteURL }}`, etc.). Supabase substitutes them at send
time.

## Previewing locally

Open any of the HTML files in your browser. The Supabase variables will appear
as literal `{{ .ConfirmationURL }}` strings; replace by hand if you want to see
exactly what a recipient will see (the comment block at the top of each file
suggests sample values).

## What I changed

Both the magic-link and invite templates now match the same visual design as
the activity digest emails: the logo, the dark-blue gradient header, the
light card with subtle shadow, the accent-blue CTA button, and a footer
linking back to the app.

The magic-link template also includes the **8-digit fallback OTP code**
(rendered in a code block) so you can sign in by typing the code on the
login screen if the link doesn't open on your device.
