"""Readable export asks for the vault password on the real app page.

Real server and Chromium: after registration, a click on #btn-export-readable-zip
opens the confirm dialog with a password step. A wrong password gives an error, no
download and no download task (the progress overlay never opens); the right
password starts the download. Without the dialog (DialogA11y.confirm returns null)
the export must not start either. Docs: docs/IMPORT_EXPORT_SPEC.md section 5.
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
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

# runFileDownloadTask is private to app.js; it always opens #file-download-progress
# first, so any call shows up as a change of that overlay.
WATCH_JS = """() => {
  window.__taskStarts = 0;
  const overlay = document.getElementById('file-download-progress');
  new MutationObserver(() => { if (!overlay.hidden) window.__taskStarts += 1; })
    .observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
  window.__downloads = 0;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) window.__downloads += 1;
    return click.call(this);
  };
  window.__nativeConfirms = 0;
  window.confirm = () => { window.__nativeConfirms += 1; return true; };
  NotesStore.upsert(crypto.randomUUID(), { type: 'note', title: 'Export me', body: 'hello', folder_id: '' });
}"""
OPEN_JS = "() => document.getElementById('btn-export-readable-zip').click()"
DIALOG = "#confirm-dialog:not([hidden])"


class ReadableExportPasswordE2E(unittest.TestCase):
    def test_wrong_password_exports_nothing_and_right_password_downloads(self):
        from playwright.sync_api import TimeoutError as PlaywrightTimeout, sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-readable-pw-"))
        port = free_port()
        # The backup section is plan gated (email_backup); run the server child on Pro.
        proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
        try:
            with sync_playwright() as p:
                browser = launch(p)
                page = browser.new_context(accept_downloads=True).new_page()
                register(page, f"http://127.0.0.1:{port}")
                page.wait_for_function(UNLOCKED_JS, timeout=120000)
                page.evaluate(WATCH_JS)

                # Fail closed: no dialog available -> no native confirm, no export.
                page.evaluate("""() => {
                  window.__realConfirm = DialogA11y.confirm;
                  DialogA11y.confirm = () => null;
                }""")
                page.evaluate(OPEN_JS)
                page.wait_for_timeout(1500)
                self.assertEqual(page.evaluate("window.__nativeConfirms"), 0)
                self.assertEqual(page.evaluate("window.__taskStarts"), 0)
                self.assertEqual(page.evaluate("window.__downloads"), 0)
                page.evaluate("() => { DialogA11y.confirm = window.__realConfirm; }")

                # Wrong password: error, no download, no download task.
                page.evaluate(OPEN_JS)
                page.wait_for_selector(DIALOG)
                page.fill("#confirm-password", "definitely-wrong-password")
                with self.assertRaises(PlaywrightTimeout):
                    with page.expect_download(timeout=4000):
                        page.click("#confirm-ok")
                page.wait_for_selector("#confirm-password-error:not([hidden])")
                self.assertEqual(page.input_value("#confirm-password"), "")
                self.assertEqual(page.evaluate("window.__taskStarts"), 0)
                self.assertEqual(page.evaluate("window.__downloads"), 0)

                # Right password: the download starts.
                page.fill("#confirm-password", PASSWORD)
                with page.expect_download(timeout=60000) as dl:
                    page.click("#confirm-ok")
                self.assertTrue(dl.value.suggested_filename.endswith(".zip"))
                self.assertGreaterEqual(page.evaluate("window.__taskStarts"), 1)
                self.assertEqual(page.input_value("#confirm-password"), "")

                # 2FA checkbox: off by default, warning only once it is ticked, reset on reopen.
                page.wait_for_function("() => !document.getElementById('btn-export-readable-zip').disabled", timeout=60000)
                page.evaluate(OPEN_JS)
                page.wait_for_selector(DIALOG)
                self.assertFalse(page.is_checked("#confirm-option"))
                self.assertTrue(page.is_hidden("#confirm-option-warning"))
                self.assertEqual(page.inner_text("#confirm-ok"), "Export unencrypted ZIP")
                page.check("#confirm-option")
                self.assertTrue(page.is_visible("#confirm-option-warning"))
                self.assertIn("inlogcodes", page.inner_text("#confirm-option-warning"))
                self.assertEqual(page.inner_text("#confirm-ok"), "Export with 2FA secrets")
                page.click("#confirm-cancel")
                page.wait_for_selector(DIALOG, state="hidden")
                page.evaluate(OPEN_JS)
                page.wait_for_selector(DIALOG)
                self.assertFalse(page.is_checked("#confirm-option"))
                self.assertTrue(page.is_hidden("#confirm-option-warning"))
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
