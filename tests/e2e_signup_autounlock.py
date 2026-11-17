"""E2E: register must land on /app unlocked (no second password prompt).

Uses official Cloudflare Turnstile dummy keys with a mocked siteverify so the
suite never contacts Cloudflare. Requires Playwright Chromium.

    python tests/e2e_signup_autounlock.py
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
TURNSTILE_TEST_SITE = "1x00000000000000000000AA"
TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA"
PASSWORD = "e2e-signup-autounlock-12"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# Variables that in-process tests set on os.environ and do not restore:
# DROPBOX_APP_KEY and GOOGLE_OAUTH_CLIENT_ID (tests/test_round63_security.py) and
# SOURCE_DATE_EPOCH (tests/test_round65_release_hash.py). The filter applies to every
# server started through start_server, not only to the tests that need it.
_APP_ENV_NAMES = {"DROPBOX_APP_KEY", "GOOGLE_OAUTH_CLIENT_ID", "SOURCE_DATE_EPOCH"}
SERVER_START_TIMEOUT_S = 60


def start_server(root: Path, port: int, extra_env: dict | None = None):
    # Do not inherit app settings from the parent process: other tests in the same
    # run set NOTES_*/STRIPE_* variables in os.environ and would leak into this server.
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("NOTES_", "STRIPE_")) and k not in _APP_ENV_NAMES
    }
    env.update(extra_env or {})
    env.update(
        NOTES_ROOT=str(root),
        NOTES_DATA=str(root / "data"),
        NOTES_KEYS=str(root / "keys"),
        NOTES_ALLOWED_CIDRS="127.0.0.1/32",
        NOTES_SKIP_LOGIN="0",
        NOTES_ALLOW_REGISTER="1",
        NOTES_DISABLE_CIDR_GATE="1",
        NOTES_STRICT_ZK="1",
        NOTES_SECURE_COOKIES="0",
        NOTES_TURNSTILE_SITE_KEY=TURNSTILE_TEST_SITE,
        NOTES_TURNSTILE_SECRET_KEY=TURNSTILE_TEST_SECRET,
        FLASK_APP="app",
        PYTHONPATH=str(APP_DIR),
    )
    (root / "keys").mkdir(parents=True, exist_ok=True)
    (root / "keys" / "flask-secret").write_text("e2e-signup-secret", encoding="utf-8")

    bootstrap = root / "run_e2e_server.py"
    bootstrap.write_text(
        f"""
import json
import urllib.request
from unittest.mock import patch

_real_urlopen = urllib.request.urlopen

class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status
    def read(self):
        return json.dumps(self._payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False

def _fake_urlopen(req, timeout=8):
    url = req.full_url if hasattr(req, "full_url") else str(req)
    if "challenges.cloudflare.com/turnstile" in url:
        return _FakeResp({{"success": True, "hostname": "localhost"}})
    return _real_urlopen(req, timeout=timeout)

with patch("urllib.request.urlopen", side_effect=_fake_urlopen):
    from app import app
    app.run(host="127.0.0.1", port={port}, use_reloader=False)
""",
        encoding="utf-8",
    )
    proc = subprocess.Popen(
        [sys.executable, str(bootstrap)],
        cwd=str(APP_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    # Wall-clock deadline: importing the app is slow on a loaded build host.
    deadline = time.monotonic() + SERVER_START_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return proc
        except OSError:
            if proc.poll() is not None:
                out = (proc.stdout.read() or b"").decode()
                raise RuntimeError(out)
            time.sleep(0.25)
    raise RuntimeError("server did not start")


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-signup-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        email = f"signup-autounlock-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            page.goto(f"{base}/register", wait_until="domcontentloaded")
            page.wait_for_selector("#register-form")

            page.fill('input[name="email"]', email)
            page.fill('#register-password', PASSWORD)
            page.fill('#register-password2', PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")

            # Bypass the live CF widget (flaky in headless) but still send a token
            # so fail-closed siteverify runs — the Flask child mocks it to success.
            page.evaluate(
                """() => {
                  document.querySelectorAll('.cf-turnstile').forEach((el) => el.remove());
                  let input = document.querySelector('input[name="cf-turnstile-response"]');
                  if (!input) {
                    input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = 'cf-turnstile-response';
                    document.getElementById('register-form').appendChild(input);
                  }
                  input.value = 'e2e-dummy-turnstile-token';
                }"""
            )
            page.click('#register-submit')

            page.wait_for_function(
                """() => {
                  if (location.pathname !== '/app') return false;
                  if (!(window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked())) return false;
                  if (!document.body.classList.contains('unlocked')) return false;
                  const el = document.getElementById('unlock-screen');
                  if (el && !el.hidden) {
                    const style = window.getComputedStyle(el);
                    if (style.display !== 'none' && style.visibility !== 'hidden') return false;
                  }
                  return true;
                }""",
                timeout=120000,
            )
            browser.close()
        print("e2e_signup_autounlock ok", email)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
