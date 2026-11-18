"""Recovery key offer for an account made before recovery keys existed
(docs/VAULT_RECOVERY.md 4, 5.2). Real server and Chromium.

The account is registered, given a note, and then put back into the state of a
pre-feature account (no wrapped copy, no pending mark). The offer must show after
unlocking, stay away after creating or postponing, and never touch stored notes.
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_recovery_key_step import DIALOG_OPEN, read_shown_key  # noqa: E402
from e2e_share_target import UNLOCKED_JS, launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

OFFER = "#recovery-key-offer"
ADD_NOTE_JS = """() => {
  NotesStore.upsert(crypto.randomUUID(), { ...NotesStore.defaultNote(), title: 'Old note', title_manual: true,
    content: 'written before recovery keys' });
}"""
RATE_LIMITS = dict(NOTES_AUTH_RATE_LIMIT="400", NOTES_AUTH_RATE_LIMIT_WAN="400")


class RecoveryKeyOfferE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright

        cls.root = Path(tempfile.mkdtemp(prefix="e2e-recovery-key-offer-"))
        port = free_port()
        cls.base = f"http://127.0.0.1:{port}"
        cls.proc = start_server(cls.root, port, RATE_LIMITS)
        cls.db_file = cls.root / "data" / "notes.db"
        cls.pw = sync_playwright().start()
        cls.browser = launch(cls.pw)
        cls.ctx = cls.browser.new_context(viewport={"width": 1280, "height": 900})
        cls.page = cls.ctx.new_page()
        cls.email = register(cls.page, cls.base)
        cls.page.evaluate(ADD_NOTE_JS)
        deadline = time.time() + 60
        while time.time() < deadline and not cls.ciphertexts():
            cls.page.wait_for_timeout(500)
        assert cls.ciphertexts(), "the note never reached the server"

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

    @classmethod
    def sql(cls, query, args=()):
        con = sqlite3.connect(cls.db_file)
        try:
            rows = con.execute(query, args).fetchall()
            con.commit()
            return rows
        finally:
            con.close()

    @classmethod
    def ciphertexts(cls):
        return cls.sql("SELECT item_uuid, ciphertext, content_hash FROM items ORDER BY item_uuid")

    def unlock_again(self):
        page = self.page
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
        page.fill("#unlock-password", PASSWORD)
        page.click("#unlock-submit")
        page.wait_for_function(UNLOCKED_JS, timeout=120000)

    def make_pre_feature_account(self):
        self.sql("DELETE FROM vault_recovery_wraps")
        self.sql("UPDATE users SET vault_key_id = ''")
        self.page.evaluate("() => Object.keys(localStorage).filter((k) => k.startsWith('notes_recovery_key_')).forEach((k) => localStorage.removeItem(k))")

    def test_offer_until_created_and_notes_unchanged(self):
        page = self.page
        before = self.ciphertexts()
        self.assertTrue(before)
        self.make_pre_feature_account()

        # Unlocking shows a non-blocking offer; the account keeps working.
        self.unlock_again()
        page.wait_for_selector(OFFER, state="visible", timeout=30000)
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertIn("recovery key", page.text_content(OFFER))
        self.assertGreaterEqual(page.evaluate("() => NotesStore.listNotes().length"), 1)

        # "Later" hides it now; it comes back at the next unlock.
        page.click("#btn-recovery-key-offer-later")
        self.assertFalse(page.is_visible(OFFER))
        self.unlock_again()
        page.wait_for_selector(OFFER, state="visible", timeout=30000)

        # Create now: same dialog as Settings; afterwards the offer is gone for good.
        page.wait_for_function("() => NotesStore.isKeyVerified()", timeout=60000)
        page.click("#btn-recovery-key-offer-now")
        key, group = read_shown_key(page)
        self.assertFalse(page.is_visible(OFFER))
        page.check("#recovery-key-stored")
        page.fill("#recovery-key-confirm-group", key.split("-")[group - 1])
        page.click("#recovery-key-save")
        page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=60000)
        self.assertEqual(len(self.sql("SELECT 1 FROM vault_recovery_wraps")), 1)
        self.unlock_again()
        page.wait_for_timeout(2000)
        self.assertFalse(page.is_visible(OFFER))

        # The stored notes are byte for byte what they were.
        self.assertEqual(self.ciphertexts(), before)

    def test_postponing_hides_the_offer_until_it_runs_out(self):
        page = self.page
        before = self.ciphertexts()
        self.make_pre_feature_account()
        self.unlock_again()
        page.wait_for_selector(OFFER, state="visible", timeout=30000)
        page.click("#btn-recovery-key-offer-postpone")
        self.assertFalse(page.is_visible(OFFER))
        self.unlock_again()
        page.wait_for_timeout(2500)
        self.assertFalse(page.is_visible(OFFER))
        self.assertEqual(self.sql("SELECT 1 FROM vault_recovery_wraps"), [])
        # After the postponement runs out the offer returns.
        page.evaluate(
            "() => { const k = Object.keys(localStorage).find((x) => x.startsWith('notes_recovery_key_postponed:'));"
            " localStorage.setItem(k, String(Date.now() - 15 * 24 * 3600 * 1000)); }"
        )
        self.unlock_again()
        page.wait_for_selector(OFFER, state="visible", timeout=30000)
        self.assertEqual(self.ciphertexts(), before)


if __name__ == "__main__":
    unittest.main()
