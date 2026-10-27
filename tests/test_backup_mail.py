"""Privacy-focused copy for daily encrypted backup emails."""
from __future__ import annotations

import re
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

import types  # noqa: E402

sys.modules.setdefault("db", types.ModuleType("db"))
mailer_stub = types.ModuleType("mailer")


def _noop_send_backup_email(*_args, **_kwargs):
    return None


mailer_stub.send_backup_email = _noop_send_backup_email
sys.modules["mailer"] = mailer_stub
config_stub = types.ModuleType("config")
config_stub.DATA_DIR = APP_DIR.parent / "data"
sys.modules.setdefault("config", config_stub)

from backup_mail import (  # noqa: E402
    BACKUP_EMAIL_SUBJECT,
    email_body_for,
    email_html_for,
    format_attachment_size,
)


def _meta(compact: bool = False) -> dict:
    return {
        "bytes_size": 6_184_320,
        "compact": compact,
        "item_count": 42,
        "local_path": "/opt/deeperguard/data/backups/user-1-full.enc.json.gz",
        "omitted": 3,
        "full_bytes": 12_000_000,
    }


def test_format_attachment_size_megabytes():
    assert format_attachment_size(6_184_320) == "~5.9 MB"


def test_plain_body_marketing_copy_no_inventory():
    body = email_body_for(_meta())
    assert BACKUP_EMAIL_SUBJECT == "Your encrypted Deeperguard backup"
    assert "Items in this email" not in body
    assert "document item" not in body.lower()
    assert "/opt/" not in body
    assert "bytes" not in body
    assert "Attachment size: ~5.9 MB" in body
    assert "Settings → Import backup" in body
    assert "`.enc.json.gz`" in body


def test_plain_body_compact_note_only_when_compact():
    full = email_body_for(_meta(compact=False))
    compact = email_body_for(_meta(compact=True))
    assert "sync backup" not in full
    assert "Large sealed files stay in your sync backup" in compact
    assert "omitted" not in compact
    assert "scanned" not in compact.lower()


def test_html_no_paths_or_counts():
    html = email_html_for(_meta(compact=True))
    assert "/opt/" not in html
    assert "Items in" not in html
    assert "Deeperguard" in html
    assert "#0d9488" in html
    assert "Encrypted" in html and "can&rsquo;t read" in html
    assert "~5.9 MB" in html
    assert re.search(r"\b42\b", html) is None
