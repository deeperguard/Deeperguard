#!/usr/bin/env python3
"""One-time H2 repair: count (and optionally fix) SRP KDF v1 lockout candidates.

Reports counts only — never prints emails or verifiers.

  NOTES_ROOT=/opt/deeperguard python3 deploy/repair-srp-kdf-lockouts.py
  NOTES_ROOT=/opt/deeperguard python3 deploy/repair-srp-kdf-lockouts.py --apply
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Set srp_kdf_version=2 for lockout-candidate rows (password_changed_at set, still v1).",
    )
    args = parser.parse_args()
    if not os.environ.get("NOTES_ROOT"):
        os.environ.setdefault("NOTES_ROOT", "/opt/deeperguard")
    import db

    residual_v1 = db.count_srp_kdf_v1_users()
    candidates = db.repair_srp_kdf_v1_lockouts(apply=False)
    print(f"srp_kdf_v1_users={residual_v1}")
    print(f"lockout_candidates={candidates}")
    if args.apply:
        fixed = db.repair_srp_kdf_v1_lockouts(apply=True)
        print(f"repaired={fixed}")
        print(f"srp_kdf_v1_users_after={db.count_srp_kdf_v1_users()}")
    else:
        print("dry_run=1 (pass --apply to repair candidates)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
