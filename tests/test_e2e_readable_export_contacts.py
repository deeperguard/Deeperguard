"""Readable export on the real app page contains contacts/contacts.vcf.

Real server and Chromium: a contact (with a non-ASCII name) is stored in the vault next to a
note, the user confirms the readable export with the vault password, the dialog counts the
contact, and the downloaded ZIP holds contacts/contacts.vcf with that contact.
Docs: docs/IMPORT_EXPORT_SPEC.md section 2, docs/HELP_CONTACTS.md.
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
  NotesStore.addContact({
    name: { given: 'Zoë', family: 'Ünal' },
    phones: [{ type: 'mobile', value: '+31 6 12345678' }],
    emails: [{ type: 'work', value: 'zoe@example.com' }],
  });
}"""
OPEN_JS = "() => document.getElementById('btn-export-readable-zip').click()"
DIALOG = "#confirm-dialog:not([hidden])"


class ReadableExportContactsE2E(unittest.TestCase):
    def test_zip_contains_contacts_vcf(self):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-readable-contacts-"))
        port = free_port()
        proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
        try:
            with sync_playwright() as p:
                browser = launch(p)
                page = browser.new_context(accept_downloads=True).new_page()
                base = f"http://127.0.0.1:{port}"
                register(page, base)
                page.wait_for_function(UNLOCKED_JS, timeout=120000)
                page.evaluate(SEED_JS)

                page.evaluate(OPEN_JS)
                page.wait_for_selector(DIALOG)
                self.assertIn("1 contact(s)", page.inner_text("#confirm-dialog"))
                page.fill("#confirm-password", PASSWORD)
                with page.expect_download(timeout=60000) as dl:
                    page.click("#confirm-ok")
                data = Path(dl.value.path()).read_bytes()
                browser.close()

            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                self.assertEqual(sorted(zf.namelist()), ["README.txt", "contacts/contacts.vcf", "notes/Export me.md"])
                vcf = zf.read("contacts/contacts.vcf").decode()
                self.assertIn("Contacts: 1", zf.read("README.txt").decode())
            self.assertTrue(vcf.startswith("BEGIN:VCARD\r\nVERSION:3.0\r\n"))
            unfolded = vcf.replace("\r\n ", "")
            self.assertIn("N:\u00dcnal;Zo\u00eb;;;\r\n", unfolded)
            self.assertIn("+31 6 12345678", unfolded)
            self.assertIn("EMAIL;TYPE=WORK:zoe@example.com\r\n", unfolded)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except Exception:
                proc.kill()
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
