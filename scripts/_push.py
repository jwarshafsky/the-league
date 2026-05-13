# Web Push helper. Uses the `pywebpush` package to send signed pushes via the
# Web Push Protocol with VAPID auth. Pruning stale subs (410 Gone) is the
# caller's responsibility — we surface failures so they can decide.
#
# Install (one-time, runs in user-site so no sudo needed):
#   /usr/bin/python3 -m pip install --user pywebpush

import json
import sys

try:
    from pywebpush import webpush, WebPushException
except ImportError:
    webpush = None
    WebPushException = Exception

try:
    from py_vapid import Vapid01
except ImportError:
    Vapid01 = None

_vapid_instance = None


def _get_vapid_instance(pem_str):
    """Load + cache a Vapid01 instance from a PEM string. pywebpush's
    `vapid_private_key=PEM` path tried to deserialize the string itself and
    failed on some cryptography/OpenSSL combos — passing a Vapid01 object
    instead works reliably.

    The PEM is stored single-line with literal `\\n` escapes in scripts/.env
    (and in GitHub Actions secrets), so we re-expand them before parsing.
    """
    global _vapid_instance
    if _vapid_instance is None:
        if Vapid01 is None:
            raise RuntimeError("py_vapid not installed — run: pip3 install --user py_vapid")
        pem = pem_str.replace("\\n", "\n")
        _vapid_instance = Vapid01.from_pem(pem.encode())
    return _vapid_instance


def send_push(subscription, payload, vapid_private_key, vapid_subject):
    """subscription: dict with keys 'endpoint' + 'keys' { p256dh, auth }.
       payload: dict to JSON-encode (rendered by SW into title/body/url/tag).
       vapid_private_key: PEM string of the VAPID EC private key.
       vapid_subject: 'mailto:you@example.com' identifying the sender."""
    if webpush is None:
        raise RuntimeError("pywebpush not installed — run: pip3 install --user pywebpush")
    return webpush(
        subscription_info=subscription,
        data=json.dumps(payload),
        vapid_private_key=_get_vapid_instance(vapid_private_key),
        vapid_claims={"sub": vapid_subject},
    )


def to_subscription_info(row):
    """Convert a push_subscriptions DB row to the dict pywebpush expects."""
    return {
        "endpoint": row["endpoint"],
        "keys": {"p256dh": row["p256dh"], "auth": row["auth_key"]},
    }


def is_gone(exc):
    """Return True if the failure indicates the subscription is permanently dead
    and should be deleted."""
    try:
        if hasattr(exc, "response") and exc.response is not None:
            code = getattr(exc.response, "status_code", None)
            if code in (404, 410): return True
    except Exception:
        pass
    return False
