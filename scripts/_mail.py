# SMTP helper. Sends a multipart HTML+text email via Gmail SMTP using the
# SMTP_USER + SMTP_PASS (App Password) creds from scripts/.env.

import smtplib
from email.message import EmailMessage


def send_email(smtp_user, smtp_pass, to_addrs, subject, html, text):
    if not to_addrs: return
    msg = EmailMessage()
    msg["From"] = f"The League <{smtp_user}>"
    msg["To"] = ", ".join(to_addrs if isinstance(to_addrs, list) else [to_addrs])
    msg["Subject"] = subject
    msg.set_content(text or "")
    msg.add_alternative(html, subtype="html")
    with smtplib.SMTP("smtp.gmail.com", 587) as s:
        s.starttls()
        s.login(smtp_user, smtp_pass)
        s.send_message(msg)
