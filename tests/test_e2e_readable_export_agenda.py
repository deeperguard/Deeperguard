"""Readable export on the real app page contains agenda/agenda.ics.

Real server and Chromium: an agenda event (a weekly series with one moved
occurrence) and an all-day event are stored in the vault, the user confirms the
readable export with the vault password, and the downloaded ZIP holds the
notes unchanged plus agenda/agenda.ics with every event. Docs: docs/IMPORT_EXPORT_SPEC.md section 2.3.
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
  NotesStore.upsertAgendaEvent('ev-weekly', {
    version: 1, title: 'Sport, team; weekly', notes: 'Line 1\\nLine 2', all_day: false,
    start: '2026-11-16T18:00:00.000Z', end: '2026-11-16T19:00:00.000Z',
    rrule: 'FREQ=WEEKLY;COUNT=3',
    ics_occurrence_overrides: { '20261123T180000Z': { title: 'Sport moved', start: '2026-11-24T18:00:00.000Z', end: '2026-11-24T19:00:00.000Z' } },
  });
  NotesStore.upsertAgendaEvent('ev-allday', {
    version: 1, title: 'Holiday', notes: '', all_day: true,
    start: new Date(2026, 11, 24).toISOString(), end: new Date(2026, 11, 25).toISOString(),
  });
}"""
OPEN_JS = "() => document.getElementById('btn-export-readable-zip').click()"
DIALOG = "#confirm-dialog:not([hidden])"


class ReadableExportAgendaE2E(unittest.TestCase):
    def test_zip_contains_agenda_ics(self):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-readable-agenda-"))
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
                self.assertIn("2 agenda event(s)", page.inner_text("#confirm-dialog"))
                page.fill("#confirm-password", PASSWORD)
                with page.expect_download(timeout=60000) as dl:
                    page.click("#confirm-ok")
                data = Path(dl.value.path()).read_bytes()
                browser.close()

            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                names = sorted(zf.namelist())
                self.assertEqual(names, ["README.txt", "agenda/agenda.ics", "notes/Export me.md"])
                self.assertTrue(zf.read("notes/Export me.md").decode().endswith("---\n\nhello\n"))
                ics = zf.read("agenda/agenda.ics").decode()
            self.assertTrue(ics.startswith("BEGIN:VCALENDAR\r\n"))
            unfolded = ics.replace("\r\n ", "")
            self.assertEqual(unfolded.count("BEGIN:VEVENT"), 3)
            self.assertEqual(unfolded.count("UID:ev-weekly\r\n"), 2)
            self.assertIn("UID:ev-allday\r\n", unfolded)
            self.assertIn("SUMMARY:Sport\\, team\\; weekly\r\n", unfolded)
            self.assertIn("DESCRIPTION:Line 1\\nLine 2\r\n", unfolded)
            self.assertIn("RRULE:FREQ=WEEKLY;COUNT=3\r\n", unfolded)
            self.assertIn("SUMMARY:Sport moved\r\n", unfolded)
            self.assertIn("RECURRENCE-ID", unfolded)
            self.assertIn("DTSTART;VALUE=DATE:20261224\r\n", unfolded)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except Exception:
                proc.kill()
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
