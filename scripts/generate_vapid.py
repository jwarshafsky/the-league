#!/usr/bin/env python3
"""
One-time VAPID keypair generator for Web Push.

Usage:
  /usr/bin/python3 -m pip install --user cryptography py_vapid
  python3 scripts/generate_vapid.py

Outputs PEM-encoded private key + the URL-safe base64 public key. Paste the
private key (multi-line) into scripts/.env as VAPID_PRIVATE_KEY=... using a
single line with \\n escapes, and the public key into js/app.js's
VAPID_PUBLIC_KEY constant.

The script also prints the corresponding `mailto:` subject string; that's
the value of VAPID_SUBJECT in scripts/.env (any contact URL works).
"""

import sys


def main():
    try:
        from py_vapid import Vapid01
    except ImportError:
        print("Missing dependency. Run:\n  /usr/bin/python3 -m pip install --user py_vapid cryptography\nthen rerun.", file=sys.stderr)
        sys.exit(1)

    v = Vapid01()
    v.generate_keys()
    private_pem = v.private_pem().decode("utf-8")
    public_b64  = v.public_key.public_numbers().__class__  # not needed; we get URL-safe below
    pub_b64 = v.public_key
    # py_vapid >=1.9 exposes `application_server_key`-style URL-safe b64.
    pub_url = v._serialize_url_safe(v.public_key) if hasattr(v, "_serialize_url_safe") else None
    if not pub_url:
        # Fallback: derive directly.
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        import base64
        raw = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        pub_url = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    print("=" * 60)
    print("VAPID keypair generated. Save these (don't commit private key!).")
    print("=" * 60)
    print()
    print("# Append to scripts/.env (private key is multi-line PEM — escape as one line):")
    one_line = private_pem.replace("\n", "\\n")
    print(f'VAPID_PRIVATE_KEY="{one_line}"')
    print('VAPID_SUBJECT="mailto:jwarshafsky@gmail.com"')
    print()
    print("# Replace VAPID_PUBLIC_KEY constant in js/app.js with:")
    print(f'const VAPID_PUBLIC_KEY = "{pub_url}";')
    print()


if __name__ == "__main__":
    main()
