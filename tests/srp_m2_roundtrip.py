"""JSON stdin/stdout helper for Node SRP M2 end-to-end tests."""
from __future__ import annotations

import json
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from srp_auth import SrpServerSession, generate_verifier_hex, new_srp_salt_hex


def main() -> None:
    req = json.load(sys.stdin)
    cmd = str(req.get("cmd") or "")
    if cmd == "setup":
        email = str(req["email"]).strip().lower()
        password = str(req["password"])
        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password)
        sess = SrpServerSession()
        b_hex = sess.step1(email, salt, verifier)
        print(
            json.dumps(
                {
                    "salt": salt,
                    "verifier": verifier,
                    "B": b_hex,
                    "state": sess.to_private_state(),
                }
            )
        )
        return
    if cmd == "step2":
        sess = SrpServerSession.from_private_state(req["state"])
        m2 = sess.step2(str(req["A"]), str(req["M1"]))
        print(json.dumps({"M2": m2}))
        return
    raise SystemExit(f"unknown cmd: {cmd}")


if __name__ == "__main__":
    main()
