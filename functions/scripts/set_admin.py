"""Bootstrap script: grant admin = true to a Firebase Auth user by email.

Run locally with `firebase login` already done:
    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
        python functions/scripts/set_admin.py max.h.silverman@gmail.com

This is a one-time thing — after the first admin exists, further admins are
granted via the `set_admin_claim` callable in the SPA.
"""

from __future__ import annotations

import sys

import firebase_admin
from firebase_admin import auth


def main(email: str) -> None:
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    user = auth.get_user_by_email(email)
    auth.set_custom_user_claims(user.uid, {"admin": True})
    print(f"OK: {email} (uid={user.uid}) is now admin.")
    print("They'll need to sign out + back in for the claim to take effect.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: set_admin.py <email>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1])
