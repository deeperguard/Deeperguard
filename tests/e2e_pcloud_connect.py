"""E2E (Playwright): connect pCloud with OAuth in the backup settings.

A real server runs with a faked pCloud API (the code exchange and the logout call are
answered in the server process) and the pCloud authorize page is answered by the browser
context with a redirect to the real callback. The test checks:

* no password / token field for the connect flow, a "Connect pCloud" button and a status
* the exact notice text, including the sentence that scheduled backups do not use it yet
* connecting through the callback: the settings open on their own, a confirmation shows,
  and ?pcloud= is removed from the URL
* a denied and a failed callback show a readable message in the app, not JSON
* a stored token that cannot be used shows "reconnect needed" and a Reconnect button
* disconnecting
* a Free account sees that this is a Pro feature before clicking, with the button disabled

    python tests/e2e_pcloud_connect.py
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""

# Runs in the server process before the app is imported: answers the pCloud API calls.
PRELUDE = '''
import json as _json
import urllib.request as _ur

_orig_urlopen = _ur.urlopen

class _PcResp:
    def __init__(self, payload):
        self._body = _json.dumps(payload).encode("utf-8")
    def read(self, n=-1):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False

def _pc_urlopen(req, timeout=8):
    url = req.full_url if hasattr(req, "full_url") else str(req)
    if "pcloud.com/oauth2_token" in url:
        body = (req.data or b"").decode("ascii")
        if "code=e2e-bad-code" in body:
            return _PcResp({"result": 2012, "error": "invalid code"})
        return _PcResp({"result": 0, "access_token": "e2e-access-token"})
    if "pcloud.com/logout" in url:
        return _PcResp({"result": 0, "auth_deleted": True})
    return _orig_urlopen(req, timeout=timeout)

_ur.urlopen = _pc_urlopen
'''

NOTICE = (
    "When you connect, the Deeperguard server stores a pCloud access token for your account. "
    "The server encrypts that token with a key that the server itself holds. This protects the "
    "token if the database leaks; it is not end-to-end encryption, and the server can decrypt the "
    "token whenever it needs it. With the token the server can use your pCloud account as far as "
    "pCloud allows this app. pCloud has no scope setting for this, so that limit comes from how "
    "the app is registered at pCloud, not from Deeperguard. You can revoke access at any time in "
    "your pCloud account settings, or choose Disconnect here: that deletes the token from the "
    "server and asks pCloud to revoke it."
)
SCHEDULE = "Scheduled backups do not use this connection yet."


def env(base: str, plan: str) -> dict:
    return {
        "NOTES_DEFAULT_PLAN": plan,
        "NOTES_PUBLIC_URL": base,
        "NOTES_PCLOUD_OAUTH_CLIENT_ID": "e2e-client",
        "NOTES_PCLOUD_OAUTH_CLIENT_SECRET": "e2e-secret",
        "NOTES_PCLOUD_CREDENTIALS_KEY": "ab" * 32,
        "NOTES_AUTH_RATE_LIMIT_WAN": "1000",
    }


def unlock(page) -> None:
    page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120000)


def open_settings(page) -> None:
    page.evaluate("() => window.notesShowSettings()")
    page.wait_for_selector("#pcloud-connect-state", state="visible", timeout=30000)
    page.wait_for_function(
        "() => !document.getElementById('pcloud-connect-state').textContent.includes('Checking')",
        timeout=30000,
    )


def state_text(page) -> str:
    return page.locator("#pcloud-connect-state").inner_text().strip()


def install_pcloud_authorize(context, base: str, mode: dict) -> None:
    """The pCloud authorize page: redirect straight back to the app's callback."""

    def handler(route, request):
        state = parse_qs(urlsplit(request.url).query)["state"][0]
        if mode["kind"] == "deny":
            query = f"error=access_denied&state={state}"
        else:
            code = "e2e-bad-code" if mode["kind"] == "fail" else "e2e-good-code"
            query = f"code={code}&state={state}&locationid=2&hostname=eapi.pcloud.com"
        route.fulfill(
            status=302,
            headers={"Location": f"{base}/api/backup/pcloud/oauth/callback?{query}"},
        )

    context.route("https://my.pcloud.com/**", handler)


def connect_and_return(page, mode: dict, kind: str) -> None:
    mode["kind"] = kind
    page.locator("#btn-pcloud-connect").click()
    page.wait_for_function("() => location.pathname === '/app' && location.search.includes('pcloud=')", timeout=30000)
    # The callback answered with a redirect: the vault is locked again after the page load.
    unlock(page)
    page.wait_for_selector("#pcloud-connect-result", state="visible", timeout=30000)


def check_free(browser) -> None:
    root = Path(tempfile.mkdtemp(prefix="e2e-pcloud-free-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port, extra_env=env(base, "free"), prelude=PRELUDE)
    try:
        page = browser.new_context(viewport={"width": 1300, "height": 1400}).new_page()
        register(page, base)
        open_settings(page)
        lock = page.locator("[data-plan-feature='pcloud_backup'] .plan-pro-lock")
        assert lock.count() == 1 and "Included with Pro" in lock.inner_text(), "Free user sees no Pro notice"
        assert page.locator("#btn-pcloud-connect").is_disabled(), "connect must be disabled before any click"
        assert state_text(page) == "Status: not connected."
    finally:
        proc.terminate()


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-pcloud-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port, extra_env=env(base, "pro"), prelude=PRELUDE)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            context = browser.new_context(viewport={"width": 390, "height": 900})
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            mode = {"kind": "ok"}
            install_pcloud_authorize(context, base, mode)
            register(page, base)
            open_settings(page)

            # Not connected: a button and a status, no password or token field to connect.
            assert state_text(page) == "Status: not connected."
            connect = page.locator("#btn-pcloud-connect")
            assert connect.inner_text() == "Connect pCloud" and connect.is_enabled()
            assert page.locator("#btn-pcloud-disconnect").is_hidden()
            assert page.locator("#pcloud-connect input, #pcloud-connect textarea").count() == 0
            assert page.locator("#pcloud-connect-notice > p:first-child").inner_text().strip() == NOTICE
            assert page.locator("#pcloud-connect-schedule").inner_text().strip() == SCHEDULE
            assert "Deeperguard folder" not in page.locator("#pcloud-connect").inner_text()
            # Keyboard: the button is reachable and shows a focus ring.
            connect.focus()
            page.keyboard.press("Shift+Tab")
            page.keyboard.press("Tab")
            assert page.evaluate("() => document.activeElement.id") == "btn-pcloud-connect"
            assert page.evaluate(
                "() => getComputedStyle(document.activeElement).outlineStyle !== 'none'"
                " || getComputedStyle(document.activeElement).boxShadow !== 'none'"
            ), "no visible focus"
            assert page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth"), "phone width overflow"

            # Denied at pCloud: readable message in the app, parameter gone, still not connected.
            connect_and_return(page, mode, "deny")
            assert "not granted" in page.locator("#pcloud-connect-result").inner_text()
            assert "pcloud=" not in page.url, page.url
            assert urlsplit(page.url).path == "/app", page.url
            assert state_text(page) == "Status: not connected."

            # Failed code exchange.
            connect_and_return(page, mode, "fail")
            assert "did not work" in page.locator("#pcloud-connect-result").inner_text()
            assert "pcloud=" not in page.url, page.url
            assert state_text(page) == "Status: not connected."

            # Success.
            connect_and_return(page, mode, "ok")
            assert page.locator("#pcloud-connect-result").inner_text().strip() == "pCloud is connected."
            assert "pcloud=" not in page.url, page.url
            page.wait_for_function(
                "() => document.getElementById('pcloud-connect-state').textContent.includes('connected.')"
                " && !document.getElementById('pcloud-connect-state').textContent.includes('not connected')",
                timeout=30000,
            )
            assert state_text(page) == "Status: connected."
            assert page.locator("#btn-pcloud-connect").is_hidden()
            assert page.locator("#btn-pcloud-disconnect").is_visible()
            # The settings were opened by the return itself.
            assert page.locator("body.settings-open").count() == 1

            # A token that cannot be used any more: reconnect needed.
            con = sqlite3.connect(str(root / "data" / "notes.db"))
            con.execute("UPDATE pcloud_oauth_tokens SET token_enc = 'unreadable'")
            con.commit()
            con.close()
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            open_settings(page)
            assert state_text(page).startswith("Status: reconnect needed"), state_text(page)
            assert page.locator("#btn-pcloud-connect").inner_text() == "Reconnect pCloud"
            assert page.locator("#btn-pcloud-connect").is_enabled()
            connect_and_return(page, mode, "ok")
            page.wait_for_function(
                "() => document.getElementById('pcloud-connect-state').textContent === 'Status: connected.'",
                timeout=30000,
            )

            # Disconnect (confirm dialog accepted); doing it again is not possible: button is gone.
            page.once("dialog", lambda d: d.accept())
            page.locator("#btn-pcloud-disconnect").click()
            page.wait_for_function(
                "() => document.getElementById('pcloud-connect-state').textContent === 'Status: not connected.'",
                timeout=30000,
            )
            assert page.locator("#btn-pcloud-disconnect").is_hidden()
            assert "confirmed the revocation" in page.locator("#pcloud-connect-result").inner_text()
            assert page.locator("#btn-pcloud-connect").inner_text() == "Connect pCloud"

            check_free(browser)
            browser.close()
        assert not errors, errors
    finally:
        proc.terminate()
    print("ok: pCloud connect")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
