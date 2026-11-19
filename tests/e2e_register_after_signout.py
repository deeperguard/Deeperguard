"""E2E: register again after 'Sign out and create a new account' (idea #224).

The test signs up a first account, opens /register, clicks 'Sign out and create a
new account', fills the form, ticks both boxes and clicks 'Create account' twice.
Within REACTION_TIMEOUT_MS either the 'Your recovery key' dialog or a visible
error message must appear. Findings: docs/findings/register-after-signout.md.

The server runs with the Cloudflare Turnstile dummy keys (siteverify is mocked by
e2e_signup_autounlock.start_server). The browser never reaches the internet:
every non-local request is aborted, except that a scenario may answer the
Turnstile script URL with a small stub that hands out a token.

    python tests/e2e_register_after_signout.py
"""
from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

from e2e_recovery_key_step import DIALOG_OPEN, complete_recovery_key_step
from e2e_signup_autounlock import free_port, start_server

PASSWORD = "e2e-register-after-signout-12"
REACTION_TIMEOUT_MS = 30000
TURNSTILE_SCRIPT = "challenges.cloudflare.com/turnstile/v0/api.js"
SERVER_ENV = {
    "NOTES_REGISTER_IP_HOURLY_CAP": "50",
    "NOTES_AUTH_RATE_LIMIT": "200",
    "NOTES_AUTH_RATE_LIMIT_WAN": "200",
}

# Stands in for Cloudflare's api.js: puts the hidden token input in every widget,
# which is what the real widget does once the check passes.
TURNSTILE_STUB_JS = """
(function () {
  function fill(el) {
    var input = el.querySelector('input[name="cf-turnstile-response"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      el.appendChild(input);
    }
    input.value = 'e2e-stub-turnstile-token';
  }
  window.turnstile = {
    render: function (el) { fill(typeof el === 'string' ? document.querySelector(el) : el); return 'stub'; },
    reset: function () { document.querySelectorAll('.cf-turnstile').forEach(fill); },
    getResponse: function () { return 'e2e-stub-turnstile-token'; },
  };
  document.querySelectorAll('.cf-turnstile').forEach(fill);
})();
"""

# Visible feedback the register page can give: the general error, the hang
# message, a field error, or the recovery key dialog after a successful sign-up.
REACTION_JS = """() => {
  const visible = (el) => !!el && !el.hidden && el.textContent.trim() !== ''
    && el.getClientRects().length > 0;
  if (document.querySelector('%s')) return 'recovery-dialog';
  for (const id of ['register-error', 'register-hang-live']) {
    if (visible(document.getElementById(id))) return id + ': ' + document.getElementById(id).textContent.trim();
  }
  for (const el of document.querySelectorAll('#register-form .field-error')) {
    if (visible(el)) return el.id + ': ' + el.textContent.trim();
  }
  return false;
}""" % DIALOG_OPEN


class SilentRegisterError(AssertionError):
    """'Create account' gave neither the recovery key dialog nor a visible error."""


class Browser:
    """One Chromium context. turnstile_mode 'stub' answers the Turnstile script with
    TURNSTILE_STUB_JS, 'blocked' aborts it like a network without Cloudflare access."""

    def __init__(self, playwright, base: str):
        self.base = base
        self.turnstile_mode = "stub"
        self.failed_requests: list[str] = []
        self.api_requests: list[str] = []
        self.browser = playwright.chromium.launch(headless=True)
        self.context = self.browser.new_context()
        self.context.route("**/*", self._route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(REACTION_TIMEOUT_MS)
        self.page.on(
            "requestfailed",
            lambda req: self.failed_requests.append(f"{req.resource_type} {req.url} -> {req.failure}"),
        )
        self.page.on(
            "request",
            lambda req: self.api_requests.append(f"{req.method} {req.url}") if "/api/" in req.url else None,
        )

    def _route(self, route):
        url = route.request.url
        if url.startswith(self.base):
            route.continue_()
        elif TURNSTILE_SCRIPT in url and self.turnstile_mode == "stub":
            route.fulfill(status=200, content_type="text/javascript", body=TURNSTILE_STUB_JS)
        else:
            route.abort("failed")

    def close(self):
        self.browser.close()


def fill_register_form(page, email: str) -> None:
    page.wait_for_selector("#register-form")
    page.fill("#register-email", email)
    page.fill("#register-password", PASSWORD)
    page.fill("#register-password2", PASSWORD)
    page.check("#register-terms")
    page.check("#register-recover-ack")


def register_first_account(b: Browser, email: str) -> None:
    b.turnstile_mode = "stub"
    b.page.goto(f"{b.base}/register", wait_until="domcontentloaded")
    fill_register_form(b.page, email)
    b.page.wait_for_function(
        "() => !!document.querySelector('input[name=\"cf-turnstile-response\"]')?.value"
    )
    b.page.click("#register-submit")
    b.page.wait_for_url("**/app*", timeout=120000)
    complete_recovery_key_step(b.page, timeout=120000)


def sign_out_and_register_twice(b: Browser, email: str, turnstile_mode: str) -> str:
    """Run the beta-tester steps; return the feedback that appeared or raise SilentRegisterError."""
    b.turnstile_mode = turnstile_mode
    page = b.page
    page.goto(f"{b.base}/register", wait_until="domcontentloaded")
    b.failed_requests.clear()
    page.click("#sign-out-create")
    page.wait_for_selector("#register-form")
    b.api_requests.clear()
    fill_register_form(page, email)
    page.click("#register-submit")
    page.wait_for_timeout(1500)
    if page.url.rstrip("/").endswith("/register"):
        # Like the tester's second click. force: the button is disabled while the
        # first attempt runs (the browser then drops the click, as for a user).
        try:
            page.click("#register-submit", force=True, timeout=3000)
        except Exception:
            # The first click already finished the sign-up and left /register.
            if page.url.rstrip("/").endswith("/register"):
                raise
    try:
        page.wait_for_function(REACTION_JS, timeout=REACTION_TIMEOUT_MS)
    except Exception as exc:
        raise SilentRegisterError(
            f"no recovery key dialog and no visible error {REACTION_TIMEOUT_MS} ms after "
            f"'Create account' (turnstile={turnstile_mode}, url={page.url}, "
            f"button={page.text_content('#register-submit')!r}, "
            f"api requests={b.api_requests}, failed requests={b.failed_requests})"
        ) from exc
    # The handle resolves to the same string REACTION_JS returned.
    return page.evaluate(REACTION_JS)


def run(turnstile_mode: str) -> str:
    """Start a fresh server, run the steps with the given Turnstile mode, return the feedback."""
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-register-after-signout-"))
    port = free_port()
    proc = start_server(root, port, SERVER_ENV)
    stamp = int(time.time() * 1000)
    try:
        with sync_playwright() as p:
            b = Browser(p, f"http://127.0.0.1:{port}")
            try:
                register_first_account(b, f"first-{stamp}@home.local")
                return sign_out_and_register_twice(b, f"second-{stamp}@home.local", turnstile_mode)
            finally:
                b.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    for mode in ("stub", "blocked"):
        try:
            print(f"turnstile={mode}: {run(mode)}")
        except SilentRegisterError as exc:
            print(f"turnstile={mode}: SILENT: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
