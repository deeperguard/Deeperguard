"""Guard: no readable pCloud/backup secret in app code, example config or log lines."""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
EXAMPLE_ENVS = [ROOT / "deploy" / "deeperguard.env.example"]
sys.path.insert(0, str(APP))

SECRET_NAME = r"(?:pcloud|backup)\w*(?:password|passwd|secret|token|credentials_key)\w*"
LITERAL = r"[A-Za-z0-9+/=_-]{12,}"
# NAME = "literal" / NAME: "literal" with a non-trivial literal value
LITERAL_ASSIGN = re.compile(r"(?i)\b" + SECRET_NAME + r"\s*[:=]\s*[\"']" + LITERAL + r"[\"']")
ENV_ASSIGN = re.compile(r"^\s*(NOTES_\w*(?:PCLOUD|BACKUP)\w*(?:PASSWORD|SECRET|TOKEN|KEY))\s*=\s*(\S*)", re.M)
OAUTH_LITERAL = re.compile(r"access_token[\"']?\s*[:=]\s*[\"'][A-Za-z0-9._-]{16,}[\"']")
LOG_CALL = re.compile(r"\blog(?:ger)?\.\w+\([^\n]*\)", re.I)
LOG_SECRET = re.compile(r"(?i)(?:pcloud|backup)[\w.]*(?:password|token|secret)\b(?!_set|_path)")


def _sources():
    for p in sorted(APP.rglob("*")):
        if p.is_file() and p.suffix in {".py", ".js", ".json", ".example", ".env"}:
            if "node_modules" in p.parts or "vendor" in p.parts:
                continue
            yield p


class NoReadableBackupSecret(unittest.TestCase):
    def test_no_literal_secret_in_app(self):
        for p in _sources():
            text = p.read_text(encoding="utf-8", errors="ignore")
            for rx in (LITERAL_ASSIGN, OAUTH_LITERAL):
                self.assertIsNone(rx.search(text), "readable backup secret in " + str(p.relative_to(ROOT)))

    def test_example_config_has_no_value(self):
        for p in EXAMPLE_ENVS:
            if not p.is_file():
                continue
            text = p.read_text(encoding="utf-8")
            for name, value in ENV_ASSIGN.findall(text):
                self.assertEqual(value, "", name + " has a value in " + p.name)

    def test_no_secret_in_log_lines(self):
        for p in APP.rglob("*.py"):
            for line in LOG_CALL.findall(p.read_text(encoding="utf-8", errors="ignore")):
                self.assertIsNone(LOG_SECRET.search(line), "secret logged in " + p.name + ": " + line[:80])

    def test_no_plaintext_rclone_config_written(self):
        src = (APP / "backup_pcloud.py").read_text(encoding="utf-8")
        self.assertNotIn("write_rclone_config", src)
        self.assertNotIn("mkstemp", src)
        self.assertNotIn("write_text", src)

    def test_rclone_remote_is_env_only(self):
        src = (APP / "backup_pcloud.py").read_text(encoding="utf-8")
        self.assertIn("RCLONE_CONFIG_", src)
        self.assertIn("os.devnull", src)
        self.assertNotIn('"--config",\n        str(', src)

    def test_guard_detects_literal(self):
        self.assertTrue(LITERAL_ASSIGN.search('pcloud_password = "hunter2hunter2xx"'))
        self.assertTrue(LOG_SECRET.search('log.info("x %s", pcloud_token)'))


if __name__ == "__main__":
    unittest.main()
