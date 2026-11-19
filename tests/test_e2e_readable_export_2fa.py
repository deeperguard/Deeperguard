"""Readable export with the 2FA checkbox on the real app page writes 2fa/otpauth.txt.

Real server and Chromium: one note and one authenticator account are stored in the
vault. The user ticks the 2FA checkbox, the button then reads "Export with 2FA
secrets", and the right vault password starts the download. The downloaded ZIP
holds the note, README.txt and 2fa/otpauth.txt with the exact otpauth URI.
Docs: docs/IMPORT_EXPORT_SPEC.md section 5.
"""
from __future__ import annotations

import io
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_share_target import UNLOCKED_JS, launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

SEED_JS = """() => {
  NotesStore.upsert(crypto.randomUUID(), { type: 'note', title: 'Export me', content: 'hello', folder_id: '' });
  NotesStore.addTotpAccount({ issuer: 'Example', account: 'alice@example.com', secret: 'JBSWY3DPEHPK3PXP' });
}"""
OPEN_JS = "() => document.getElementById('btn-export-readable-zip').click()"
DIALOG = "#confirm-dialog:not([hidden])"
OTPAUTH_LINE = (
    "otpauth://totp/Example:alice%40example.com"
    "?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30"
)


class ReadableExportTwoFaE2E(unittest.TestCase):
    def test_checkbox_export_zip_holds_otpauth_file(self):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-readable-2fa-"))
        port = free_port()
        proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
        try:
            with sync_playwright() as p:
                browser = launch(p)
                page = browser.new_context(accept_downloads=True).new_page()
                register(page, f"http://127.0.0.1:{port}")
                page.wait_for_function(UNLOCKED_JS, timeout=120000)
                page.evaluate(SEED_JS)

                page.evaluate(OPEN_JS)
                page.wait_for_selector(DIALOG)
                page.check("#confirm-option")
                self.assertEqual(page.inner_text("#confirm-ok"), "Export with 2FA secrets")
                page.fill("#confirm-password", PASSWORD)
                with page.expect_download(timeout=60000) as dl:
                    page.click("#confirm-ok")
                data = Path(dl.value.path()).read_bytes()
                browser.close()

            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                names = sorted(zf.namelist())
                self.assertEqual(names, ["2fa/otpauth.txt", "README.txt", "notes/Export me.md"])
                otpauth = zf.read("2fa/otpauth.txt").decode()
                readme = zf.read("README.txt").decode()
            self.assertEqual(otpauth, OTPAUTH_LINE + "\n")
            self.assertIn("2fa/ included: yes", readme)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except Exception:
                proc.kill()
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
