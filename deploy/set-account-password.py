#!/usr/bin/env python3
"""Update a user's login/vault password hash on the server.

For SRP accounts, also updates the SRP verifier so zero-knowledge login works.
Does NOT re-encrypt notes — run change vault password in the app on an unlocked
device (Settings → Security) so ciphertext matches the new password.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
from passwords import hash_password  # noqa: E402
from srp_auth import generate_verifier_hex, new_srp_salt_hex  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", help="Account email (default: first user)")
    parser.add_argument("--password", required=True, help="New vault/login password")
    args = parser.parse_args()

    user = db.get_user_by_email(args.email) if args.email else db.get_first_user()
    if not user:
        print("User not found", file=sys.stderr)
        return 1
    if len(args.password) < 8:
        print("Password must be at least 8 characters", file=sys.stderr)
        return 1

    uid = int(user["id"])
    email = str(user["email"])
    if db.user_auth_method(user) == "srp":
        srp_salt = new_srp_salt_hex()
        srp_verifier = generate_verifier_hex(srp_salt, email, args.password)
        db.update_user_srp_verifier(uid, srp_salt, srp_verifier)
        db.update_user_password(uid, hash_password(args.password))
        print(f"Updated SRP verifier and legacy hash for {email} (user_id={uid})")
    else:
        db.update_user_password(uid, hash_password(args.password))
        print(f"Updated password hash for {email} (user_id={uid})")
    print("Important: re-encrypt notes via Settings → Change vault password on an unlocked device.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
