"""Local export and backup buttons stay usable on the Free plan.

Real server and Chromium on the Free plan: "Save backup file" and "Export
everything readable (ZIP)" are built on this device, so the Pro gate on email
backup (data-plan-feature="email_backup") must not disable them. The ZIP button
opens its confirm dialog with an enabled 2FA checkbox. The Pro-only email
backup block stays locked.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_share_target import UNLOCKED_JS, launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

DIALOG = "#confirm-dialog:not([hidden])"
LOCKED_JS = "() => document.querySelector('[data-plan-feature=\"email_backup\"].plan-locked')"


class ReadableExportFreePlanE2E(unittest.TestCase):
    def test_local_export_buttons_usable_while_email_backup_stays_locked(self):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-readable-free-"))
        port = free_port()
        proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "free"})
        try:
            with sync_playwright() as p:
                browser = launch(p)
                page = browser.new_context().new_page()
                register(page, f"http://127.0.0.1:{port}")
                page.wait_for_function(UNLOCKED_JS, timeout=120000)
                page.evaluate(
                    "() => NotesStore.upsert(crypto.randomUUID(), "
                    "{ type: 'note', title: 'Export me', body: 'hello', folder_id: '' })"
                )
                # Plan gates are applied once the account has loaded.
                page.wait_for_function(LOCKED_JS, timeout=60000)

                for button in ("btn-save-backup-file", "btn-export-readable-zip", "btn-export-note"):
                    self.assertFalse(page.evaluate(f"document.getElementById('{button}').disabled"), button)
                self.assertFalse(page.evaluate("document.getElementById('restore-backup-file').disabled"))
                # The Pro-only email backup stays locked.
                self.assertTrue(page.evaluate("document.getElementById('btn-backup-now').disabled"))

                page.evaluate("() => document.getElementById('btn-export-readable-zip').click()")
                page.wait_for_selector(DIALOG)
                self.assertFalse(page.is_disabled("#confirm-option"))
                page.check("#confirm-option")
                self.assertTrue(page.is_checked("#confirm-option"))
                self.assertTrue(page.is_visible("#confirm-option-warning"))
                page.click("#confirm-cancel")
                # The button's explanation is named by aria-describedby and is visible in Settings.
                page.evaluate("() => window.notesShowSettings()")
                page.wait_for_selector("#settings-panel:not([hidden])")
                describedby = page.get_attribute("#btn-export-readable-zip", "aria-describedby")
                self.assertIsNotNone(describedby)
                self.assertTrue(page.is_visible(f"#{describedby}"), describedby)
                self.assertTrue(page.inner_text(f"#{describedby}").strip())
                browser.close()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except Exception:
                proc.kill()
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
