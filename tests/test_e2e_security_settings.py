"""Security part of Settings: five groups in order, overview, state in words, no sideways scroll.

Real server and Chromium, one registered account shared by the tests.
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

GROUPS = [
    "1. Sign in",
    "2. Open the vault",
    "3. If something goes wrong",
    "4. Keep a copy",
    "5. Devices and sessions",
]
RK_STATUS = "#recovery-key-settings-status"

# Every state label next to a heading: [heading text, state text].
STATES_JS = """() => [...document.querySelectorAll('#settings-panel .security-block-head')].map((head) => [
  head.querySelector('h4, h5').textContent.trim(),
  head.querySelector('.settings-state').textContent.trim(),
])"""

# Right edge of everything in the security groups, and whether the panel scrolls sideways.
OVERFLOW_JS = """() => {
  const body = document.querySelector('#settings-panel .settings-body');
  const limit = body.getBoundingClientRect().right + 1;
  const wide = [...document.querySelectorAll('#settings-panel [id^="sec-group-"], #settings-panel #signed-in-devices-group, #settings-security-overview *')]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > limit)
    .map((el) => el.id || el.tagName);
  return { scrolls: body.scrollWidth > body.clientWidth, wide };
}"""


class SecuritySettingsE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright

        cls.root = Path(tempfile.mkdtemp(prefix="e2e-security-settings-"))
        port = free_port()
        cls.base = f"http://127.0.0.1:{port}"
        cls.proc = start_server(cls.root, port, {"NOTES_AUTH_RATE_LIMIT": "400", "NOTES_AUTH_RATE_LIMIT_WAN": "400"})
        cls.db_file = cls.root / "data" / "notes.db"
        cls.pw = sync_playwright().start()
        cls.browser = launch(cls.pw)
        cls.ctx = cls.browser.new_context(viewport={"width": 1280, "height": 900})
        cls.page = cls.ctx.new_page()
        register(cls.page, cls.base)
        cls.page.wait_for_timeout(500)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.close()
            cls.pw.stop()
        finally:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=10)
            except Exception:
                cls.proc.kill()
            shutil.rmtree(cls.root, ignore_errors=True)

    def sql(self, query, args=()):
        con = sqlite3.connect(self.db_file)
        try:
            rows = con.execute(query, args).fetchall()
            con.commit()
            return rows
        finally:
            con.close()

    def open_settings(self):
        page = self.page
        if page.is_visible("#settings-panel"):
            page.evaluate("() => window.notesShowSettings()")
        else:
            page.locator("#btn-settings-head, #btn-settings-nav").locator("visible=true").first.click()
        page.wait_for_function(
            "() => !/Checking/.test(document.getElementById('sec-state-devices').textContent)"
            " && !/Checking/.test(document.getElementById('recovery-key-settings-status').textContent)"
            " && !/Checking/.test(document.getElementById('totp-status').textContent)"
        )

    def states(self):
        return dict(self.page.evaluate(STATES_JS))

    def test_five_groups_in_order_each_with_a_purpose_sentence(self):
        self.open_settings()
        headings = self.page.evaluate(
            "() => [...document.querySelectorAll('#settings-panel h3')].map((h) => h.textContent.trim())"
        )
        positions = [headings.index(name) for name in GROUPS]
        self.assertEqual(positions, sorted(positions))
        self.assertLess(headings.index("Security overview"), positions[0])
        for name in GROUPS:
            purpose = self.page.evaluate(
                """(name) => {
                  const h = [...document.querySelectorAll('#settings-panel h3')].find((el) => el.textContent.trim() === name);
                  const p = h.parentElement.querySelector('.security-group-purpose');
                  return p ? p.textContent.trim() : '';
                }""",
                name,
            )
            self.assertGreater(len(purpose), 30, name)
            self.assertTrue(purpose.endswith("."), name)

    def test_overview_points_to_the_setting_for_each_problem(self):
        self.open_settings()
        text = self.page.text_content("#settings-security-overview").lower()
        for needle in ("signing in", "unlocking the vault", "lost my phone", "forgot my master password", "lost a device"):
            self.assertIn(needle, text)
        self.assertIn("vault recovery key", text)
        self.assertIn("recovery code", text)
        self.assertIn("devices and sessions", text)

    def test_recovery_codes_and_recovery_key_say_what_they_are_for_and_that_they_differ(self):
        self.open_settings()
        codes = self.page.text_content("#passkey-signin-settings strong")
        self.assertIn("signing in", codes)
        self.assertIn("not the vault recovery key", codes)
        key = self.page.text_content("#recovery-key-settings strong")
        self.assertIn("forget your master password", key)
        self.assertIn("not one of the account recovery codes", self.page.text_content("#recovery-key-settings"))

    def test_2fa_state_off_then_on(self):
        self.open_settings()
        self.assertEqual(self.page.text_content("#totp-status").strip(), "Off")
        self.assertTrue(self.page.is_visible("#btn-setup-totp"))
        self.assertTrue(self.page.is_hidden("#btn-disable-totp"))

        # The server would demand a 2FA code for the session; serve the account as one with 2FA on.
        def with_2fa(route):
            body = route.fetch().json()
            body["totp_enabled"] = True
            route.fulfill(json=body)

        self.page.route("**/api/account", with_2fa)
        try:
            self.page.evaluate("() => NotesStore.loadAccount({ force: true })")
            self.open_settings()
            self.page.wait_for_function("() => document.getElementById('totp-status').textContent.trim() === 'On'")
            self.assertEqual(self.states()["2FA for signing in to Deeperguard"], "On")
            self.assertTrue(self.page.is_visible("#btn-disable-totp"))
        finally:
            self.page.unroute("**/api/account")
        self.page.evaluate("() => NotesStore.loadAccount({ force: true })")
        self.open_settings()
        self.page.wait_for_function("() => document.getElementById('totp-status').textContent.trim() === 'Off'")

    def test_recovery_key_state_active_then_not_set_up(self):
        self.open_settings()
        self.page.wait_for_function(
            "() => /^Recovery key: active since/.test(document.getElementById('recovery-key-settings-status').textContent)"
        )
        self.assertEqual(self.page.text_content(RK_STATUS).strip().split(" since")[0], "Recovery key: active")
        rows = self.sql("SELECT * FROM vault_recovery_wraps")
        self.assertEqual(len(rows), 1)
        self.sql("DELETE FROM vault_recovery_wraps")
        try:
            self.page.evaluate("() => NotesRecoveryKeySetup.refreshSettings()")
            self.page.wait_for_function(
                "() => document.getElementById('recovery-key-settings-status').textContent.trim() === 'Recovery key: not set up'"
            )
            self.assertEqual(self.states()["Vault recovery key"], "Recovery key: not set up")
        finally:
            self.restore_rows(rows)

    def restore_rows(self, rows):
        cols = [c[1] for c in self.sql("PRAGMA table_info(vault_recovery_wraps)")]
        marks = ",".join("?" for _ in cols)
        for row in rows:
            self.sql(f"INSERT INTO vault_recovery_wraps ({','.join(cols)}) VALUES ({marks})", row)

    def test_every_block_shows_a_state_in_words(self):
        self.open_settings()
        pairs = self.page.evaluate(STATES_JS)
        titles = [t for t, _ in pairs]
        for expected in (
            "Account password", "Passkeys", "2FA for signing in to Deeperguard", "Master password", "Locking",
            "Open the vault with a passkey", "Recovery codes (account sign-in)", "Vault recovery key",
            "Backup file", "Google Drive", "Dropbox", "Email backup", "pCloud backup", "Signed-in devices",
        ):
            self.assertIn(expected, titles)
        for title, state in pairs:
            self.assertTrue(state, title)
            self.assertNotIn("Checking", state, title)
        states = dict(pairs)
        self.assertEqual(states["Passkeys"], "Not set up")
        self.assertEqual(states["Recovery codes (account sign-in)"], "Not set up")
        self.assertEqual(states["Open the vault with a passkey"], "Off")
        self.assertEqual(states["Signed-in devices"], "1 device signed in")

    def test_lock_state_follows_the_auto_lock_choice(self):
        self.open_settings()
        self.page.select_option("#pref-auto-lock", "5")
        self.assertEqual(self.states()["Locking"], "Auto-lock after 5 minutes")
        self.page.select_option("#pref-auto-lock", "0")
        self.assertEqual(self.states()["Locking"], "Auto-lock off")

    def test_no_sideways_scroll_at_desktop_and_phone_width(self):
        for width, height in ((1280, 900), (390, 844)):
            self.page.set_viewport_size({"width": width, "height": height})
            try:
                self.open_settings()
                result = self.page.evaluate(OVERFLOW_JS)
                self.assertEqual(result, {"scrolls": False, "wide": []}, f"{width}px")
            finally:
                self.page.set_viewport_size({"width": 1280, "height": 900})


if __name__ == "__main__":
    unittest.main()
