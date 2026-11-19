"""E2E: pCloud connect settings (button, status, reconnect, disconnect).

    python tests/e2e_pcloud_connect.py

The pCloud side is imitated: the authorize page is stubbed and a stored token is
written straight into the database, as the OAuth callback would do.
"""
from __future__ import annotations

import os
import socket
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

from e2e_signup_autounlock import spawn_server
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
PASSWORD = "e2e-pcloud-connect-12chars"
KEY = "11" * 32
TOKEN = "fake-pcloud-token"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(root: Path, port: int):
    env = dict(os.environ)
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
        NOTES_PCLOUD_CREDENTIALS_KEY=KEY,
        NOTES_PCLOUD_OAUTH_CLIENT_ID="e2e-client",
        NOTES_PCLOUD_OAUTH_CLIENT_SECRET="e2e-secret",
        NOTES_PUBLIC_URL=f"http://127.0.0.1:{port}",
        FLASK_APP="app",
        PYTHONPATH=str(APP_DIR),
    )
    env.pop("NOTES_TURNSTILE_SECRET_KEY", None)
    env.pop("NOTES_TURNSTILE_SITE_KEY", None)
    (root / "keys").mkdir(parents=True, exist_ok=True)
    (root / "keys" / "flask-secret").write_text("e2e-pcloud-connect", encoding="utf-8")
    return spawn_server(
        root,
        [sys.executable, "-m", "flask", "run", "--host", "127.0.0.1", "--port", str(port)],
        env,
        port,
        timeout_s=20,
    )


def db_exec(root: Path, sql: str, args=()) -> None:
    conn = sqlite3.connect(str(root / "data" / "notes.db"), timeout=10)
    try:
        conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


def store_token(root: Path, token_enc: str) -> None:
    db_exec(
        root,
        "INSERT OR REPLACE INTO pcloud_oauth_tokens (user_id, token_enc, api_host, connected_at) "
        "VALUES ((SELECT id FROM users LIMIT 1), ?, 'eapi.pcloud.com', ?)",
        (token_enc, time.time()),
    )


def show_status(page, state: str) -> None:
    """(Re)open the settings, which fetches the connect status again, and wait for `state`."""
    page.evaluate("() => window.notesShowSettings()")
    page.wait_for_function(
        "(s) => document.getElementById('pcloud-connect-state').textContent === s", arg=state, timeout=30000
    )
    page.locator("#pcloud-connect").scroll_into_view_if_needed()


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-pcloud-connect-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = KEY
    proc = start_server(root, port)
    try:
        email = f"pcloud-connect-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 390, "height": 800})
            page.goto(f"{base}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', email)
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                """() => location.pathname === '/app'
                  && !!(window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked())
                  && !!(NotesStore.isKeyVerified && NotesStore.isKeyVerified())""",
                timeout=120000,
            )
            complete_recovery_key_step(page)
            db_exec(root, "UPDATE users SET plan = 'pro'")
            check(page.evaluate("async () => (await NotesStore.loadAccount({ force: true })).plan") == "pro", "pro plan")

            authorize_urls = []

            def stub_pcloud(route):
                authorize_urls.append(route.request.url)
                route.fulfill(status=200, body="stub")

            page.route("https://my.pcloud.com/**", stub_pcloud)

            # Not connected: a connect button, no password field.
            show_status(page, "Not connected")
            check(page.locator("#btn-pcloud-connect").is_visible(), "connect button visible")
            check(page.inner_text("#btn-pcloud-connect") == "Connect pCloud", "connect label")
            check(page.locator("#btn-pcloud-disconnect").is_hidden(), "no disconnect when not connected")
            check(page.locator("#pcloud-connect input[type=password]").count() == 0, "no password field")
            check("cannot read it" in page.inner_text("#pcloud-connect"), "server notice present")

            # Connected (token stored as the callback would).
            sys.path.insert(0, str(APP_DIR))
            import pcloud_credentials as pc

            store_token(root, pc.encrypt_at_rest(TOKEN))
            show_status(page, "Connected")
            check(page.locator("#btn-pcloud-connect").is_hidden(), "connect hidden when connected")
            check(page.locator("#btn-pcloud-disconnect").is_visible(), "disconnect visible")

            # Unusable stored token: reconnect needed, with a reconnect button.
            store_token(root, "not-decryptable")
            show_status(page, "Reconnect needed")
            check(page.inner_text("#btn-pcloud-connect") == "Reconnect pCloud", "reconnect label")
            check(page.locator("#btn-pcloud-connect").is_visible(), "reconnect button visible")
            check("Connect again" in page.inner_text("#pcloud-connect-note"), "reconnect note")

            # Disconnect removes the stored token.
            page.click("#btn-pcloud-disconnect")
            page.wait_for_function(
                "() => document.getElementById('pcloud-connect-state').textContent === 'Not connected'",
                timeout=60000,
            )
            check(page.locator("#btn-pcloud-disconnect").is_hidden(), "disconnect hidden after")
            conn = sqlite3.connect(str(root / "data" / "notes.db"))
            left = conn.execute("SELECT COUNT(*) FROM pcloud_oauth_tokens").fetchone()[0]
            conn.close()
            check(left == 0, "token row deleted")

            # Clicking the button starts OAuth and leaves for pCloud.
            page.click("#btn-pcloud-connect")
            page.wait_for_url("https://my.pcloud.com/**", timeout=15000)
            check(len(authorize_urls) == 1 and "client_id=e2e-client" in authorize_urls[0], "authorize url")
            check("state=" in authorize_urls[0], "authorize url has state")
            browser.close()
        print("ok: pcloud connect e2e")
        return 0
    finally:
        proc.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
