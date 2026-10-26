#!/usr/bin/env python3
"""Regenerate app/verify-metadata-baseline.json from static client code analysis.

Rows stay UNCHECKED until required endpoint references are found in the expected
source files. Re-run after client sync/unlock changes and bump baseline_version
when the table meaning changes (not on every release tag refresh).

Usage:
  python3 scripts/regenerate-verify-metadata-baseline.py
  python3 scripts/regenerate-verify-metadata-baseline.py --check
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
OUT = APP / "verify-metadata-baseline.json"

EVIDENCE_STATIC_SOURCE = "static_source_analysis"
EVIDENCE_LIVE_CAPTURE = "live_traffic_capture"

STORE = (APP / "static" / "js" / "store.js").read_text(encoding="utf-8")
APP_JS = (APP / "static" / "js" / "app.js").read_text(encoding="utf-8")
SRP = (APP / "static" / "js" / "srp-auth.js").read_text(encoding="utf-8")


def _release_tag() -> str:
    tag_path = ROOT / "RELEASE_TAG"
    try:
        return tag_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _open_note_block() -> str:
    m = re.search(r"function openNote\([^)]*\)\s*\{", APP_JS)
    if not m:
        return ""
    start = m.end()
    depth = 1
    i = start
    while i < len(APP_JS) and depth:
        ch = APP_JS[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    return APP_JS[start : i - 1]


def _static_evidence() -> dict:
    """Per-row evidence backing (generator output is always static source today)."""
    return {"evidence_type": EVIDENCE_STATIC_SOURCE}


def _uncovered_actions() -> list[dict]:
    """In-app actions not yet modeled as baseline rows (honesty gap list)."""
    return [
        {
            "id": "sign-in-register",
            "label": "Sign in (SRP-6a) and register",
            "note": "Auth traffic is described in section 2 on /verify, not as a per-action row here.",
        },
        {
            "id": "sign-out",
            "label": "Sign out",
            "note": "Typically POST /api/auth/logout; not baseline-checked yet.",
        },
        {
            "id": "delete-item",
            "label": "Delete note, file, folder, tag, or 2FA entry",
            "note": "Usually ciphertext tombstones via POST /api/sync/items; not a separate row yet.",
        },
        {
            "id": "passkeys",
            "label": "Passkeys (WebAuthn register / sign-in)",
            "note": "Separate /api/auth/webauthn/* routes; not in this table yet.",
        },
        {
            "id": "account-settings",
            "label": "Account password change, vault KDF upgrade, repair login",
            "note": "Additional /api/account/* and /api/auth/* proof routes; not baseline rows yet.",
        },
        {
            "id": "import-export",
            "label": "Import / export vault backup",
            "note": "Mostly local file I/O; any sync afterward follows edit/unlock rows.",
        },
        {
            "id": "secure-send",
            "label": "Secure Send (share / receive link)",
            "note": "See section 5 (#verify-secure-send); different routes than sync.",
        },
        {
            "id": "ask-ai",
            "label": "Ask AI (Ollama Cloud relay)",
            "note": "Note plaintext can leave the vault; see section 6 (#verify-ask-ai).",
        },
    ]


def _checked(required: list[tuple[str, str]]) -> tuple[str, str]:
    """Return (measurement, note) where measurement is checked or unchecked."""
    missing = []
    for needle, label in required:
        hay = STORE if label == "store.js" else APP_JS if label == "app.js" else SRP
        if needle not in hay:
            missing.append(f"{label}: {needle}")
    if missing:
        return "unchecked", "UNCHECKED — missing code anchor: " + "; ".join(missing)
    return "checked", "Checked against client source (static analysis). Confirm in DevTools."


def _actions() -> list[dict]:
    open_body = _open_note_block()
    open_no_api = "/api/" not in open_body

    unlock_meas, unlock_note = _checked(
        [
            ("'/api/sync/pull'", "store.js"),
            ("probeServerKey", "store.js"),
            ("ensureServerSession", "app.js"),
            ("accountUnlock", "srp-auth.js"),
            ("/api/account/unlock/challenge", "srp-auth.js"),
        ]
    )

    open_meas = "checked" if open_no_api else "unchecked"
    open_note = (
        "Checked: openNote has no direct /api/ calls (switching notes may flush/sync first)."
        if open_meas == "checked"
        else "UNCHECKED — openNote appears to call the API; re-read app.js."
    )

    edit_meas, edit_note = _checked(
        [
            ("'/api/sync/items'", "store.js"),
            ("encryptObject", "store.js"),
        ]
    )

    view_meas, view_note = _checked(
        [
            ("fetchServerItem", "store.js"),
            ("`/api/sync/item/", "store.js"),
            ("openServerCopyView", "app.js"),
        ]
    )

    idle_meas, idle_note = _checked(
        [
            ("hasRemoteChanges", "store.js"),
            ("'/api/sync/watermark'", "store.js"),
            ("pollRemoteChanges", "app.js"),
        ]
    )

    lock_meas, lock_note = _checked(
        [
            ("function lockVault", "app.js"),
            ("syncWhileLocked", "store.js"),
            ("pushDirtyPersisted", "store.js"),
        ]
    )

    static = _static_evidence()
    return [
        {
            "id": "unlock",
            "label": "Unlock vault",
            "summary": "Derive the vault key locally, then refresh session and sync ciphertext.",
            "typical_requests": [
                "GET /api/account (session refresh)",
                "POST /api/sync/pull (ciphertext rows; probe + post-unlock sync)",
                "POST /api/account/unlock/challenge + POST /api/account/unlock (SRP proofs only — empty vault / account proof)",
            ],
            "sends_nothing_typical": False,
            "note_plaintext_on_wire": False,
            "password_or_vault_key_on_wire": False,
            **static,
            "measurement": unlock_meas,
            "measurement_note": unlock_note,
        },
        {
            "id": "open",
            "label": "Open a note",
            "summary": "Load decrypted content from this device; no server read of note bodies.",
            "typical_requests": [],
            "sends_nothing_typical": True,
            "sends_nothing_caveat": "Switching away from another note with unsaved edits may push ciphertext first.",
            "note_plaintext_on_wire": False,
            "password_or_vault_key_on_wire": False,
            **static,
            "measurement": open_meas,
            "measurement_note": open_note,
        },
        {
            "id": "edit-save",
            "label": "Edit + save",
            "summary": "Autosave encrypts in the browser, then pushes ciphertext envelopes.",
            "typical_requests": [
                "POST /api/sync/items (ciphertext + plaintext metadata fields)",
                "POST /api/sync/blobs (encrypted attachment blobs, when applicable)",
            ],
            "sends_nothing_typical": False,
            "note_plaintext_on_wire": False,
            "password_or_vault_key_on_wire": False,
            **static,
            "measurement": edit_meas,
            "measurement_note": edit_note,
        },
        {
            "id": "view-server-copy",
            "label": "View server copy",
            "summary": "Fetch one stored row exactly as the API keeps it (metadata + ciphertext).",
            "typical_requests": [
                "GET /api/sync/item/<uuid>?include_blobs=…",
            ],
            "sends_nothing_typical": False,
            "note_plaintext_on_wire": False,
            "password_or_vault_key_on_wire": False,
            **static,
            "measurement": view_meas,
            "measurement_note": view_note,
        },
        {
            "id": "idle",
            "label": "Idle (vault unlocked)",
            "summary": "Background poll while you are not editing; may pull when the server watermark moves.",
            "typical_requests": [
                "GET /api/sync/watermark (lightweight poll)",
                "POST /api/sync/pull (only when watermark advances or dirty items exist)",
                "POST /api/sync/items (when local edits are still dirty)",
            ],
            "sends_nothing_typical": False,
            "note_plaintext_on_wire": False,
            "password_or_vault_key_on_wire": False,
            **static,
            "measurement": idle_meas,
            "measurement_note": idle_note,
        },
        {
            "id": "lock",
            "label": "Lock vault",
            "summary": "Flush pending ciphertext, drop keys from memory, keep optional locked sync.",
            "typical_requests": [
                "POST /api/sync/items (pending edits, before lock)",
                "POST /api/sync/pull / push while locked (ciphertext only, when enabled)",
            ],
            "sends_nothing_typical": False,
            "sends_nothing_caveat": "No requests when there is nothing dirty and background locked-sync is quiet.",
            "note_plaintext_on_wire": False,
            "password_or_vault_key_on_wire": False,
            **static,
            "measurement": lock_meas,
            "measurement_note": lock_note,
        },
    ]


def build_document() -> dict:
    return {
        "schema_version": 1,
        "baseline_version": 2,
        "release_tag": _release_tag(),
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "generation": "scripts/regenerate-verify-metadata-baseline.py (static code anchors)",
        "evidence_legend": {
            EVIDENCE_STATIC_SOURCE: "Static source analysis — required strings found in shipped client JS; not a live Network capture.",
            EVIDENCE_LIVE_CAPTURE: "Live traffic capture — someone reproduced the action in DevTools and saved the requests (none in this baseline yet).",
        },
        "uncovered_actions": _uncovered_actions(),
        "actions": _actions(),
    }


def _canonical_for_check(doc: dict) -> dict:
    """Fields that change every run without semantic drift."""
    copy = json.loads(json.dumps(doc))
    copy.pop("generated_at", None)
    return copy


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit 1 if on-disk JSON differs from a fresh regeneration.",
    )
    args = parser.parse_args()
    doc = build_document()
    rendered = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not OUT.is_file():
            print(f"Missing {OUT}", file=sys.stderr)
            return 1
        on_disk = json.loads(OUT.read_text(encoding="utf-8"))
        if _canonical_for_check(on_disk) != _canonical_for_check(doc):
            print("verify-metadata-baseline.json is stale; run regenerate-verify-metadata-baseline.py", file=sys.stderr)
            return 1
        print("verify-metadata-baseline.json ok")
        return 0
    OUT.write_text(rendered, encoding="utf-8")
    print(f"Wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
