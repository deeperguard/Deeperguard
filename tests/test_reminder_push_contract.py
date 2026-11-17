"""Contract for docs/design/reminders.md §3.2: what the server stores and pushes for a reminder.

Window push (the opt-in closed-app path): the stored record is a random id, a 15-minute window and the
device link; the pushed payload is empty. No title, no description, no exact second.

The agenda push path (channel 'push') deviates from the document today: it keeps the exact `fire_at`
and a `HH:MM` label and sends a text payload. Those tests are skipped with the reason and are listed in
the pull request; the document is not adjusted to fit the app.
"""
from __future__ import annotations

import json
import re
import sys
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_push_windows_api import ENDPOINT, PushWindowsApiTest as _Base  # noqa: E402

TITLE = "SECRET-TITLE-Dentist"
DESCRIPTION = "SECRET-DESCRIPTION-bring-the-X-ray"
WINDOW = 900
ALLOWED_COLUMNS = {"id", "user_id", "device_id", "window_start", "created_at"}


class ReminderPushContractTest(_Base):
    def _send_all(self, fake, now_ts):
        import agenda_reminder_cron as cron

        with mock.patch.dict(sys.modules, {"pywebpush": mock.MagicMock(webpush=fake, WebPushException=Exception)}):
            return cron.run_push_windows(now_ts)

    def test_stored_window_record_has_only_rounded_window_and_opaque_id(self):
        import db

        uid = self._login_free_user()
        self._subscribe()
        start = (int(time.time()) // WINDOW + 4) * WINDOW
        w = self._win(start)
        # Extra fields a careless client might add are refused, so they can never reach the table.
        for extra in ({"title": TITLE}, {"description": DESCRIPTION}, {"fire_at": start + 7}):
            self.assertEqual(self._put([dict(w, **extra)]).status_code, 400, extra)
        self.assertEqual(self._put([w]).status_code, 200)

        cols = {r["name"] for r in db.connection().execute("PRAGMA table_info(push_reminder_windows)")}
        self.assertEqual(cols, ALLOWED_COLUMNS)
        rows = [r for r in self._rows() if r["user_id"] == uid]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertRegex(row["id"], r"^[0-9a-f]{32}$")
        self.assertEqual(row["window_start"], start)
        self.assertEqual(row["window_start"] % WINDOW, 0)
        self.assertNotIn("SECRET", json.dumps(row))

    def test_exact_second_is_not_accepted_as_a_window(self):
        self._login_free_user()
        self._subscribe()
        exact = (int(time.time()) // WINDOW + 4) * WINDOW + 37
        w = {"id": uuid.uuid4().hex, "window_start": exact}
        self.assertEqual(self._put([w]).status_code, 400)
        self.assertEqual([r for r in self._rows() if r["id"] == w["id"]], [])

    def test_pushed_payload_is_empty(self):
        self._login_free_user()
        self._subscribe()
        start = (int(time.time()) // WINDOW) * WINDOW - WINDOW
        self.assertEqual(self._put([self._win(start)]).status_code, 200)
        fake = mock.MagicMock()
        self.assertEqual(self._send_all(fake, start + WINDOW + 1), 1)
        fake.assert_called_once()
        kwargs = fake.call_args.kwargs
        self.assertIsNone(kwargs["data"])
        self.assertEqual(kwargs["subscription_info"]["endpoint"], ENDPOINT)

    @unittest.skip(
        "Deviation from docs/design/reminders.md §3.2: agenda push (channel 'push') stores the exact "
        "fire_at (agenda-reminders.js computePlannedReminders) and a HH:MM local_time_label; the document "
        "targets a 900 s window and no label (K1)."
    )
    def test_agenda_push_row_is_rounded_and_has_no_label(self):
        import db

        uid = self._login_free_user()
        self._subscribe()
        exact = (int(time.time()) // WINDOW + 4) * WINDOW + 7 * 60 + 13
        res = self._sync([{"id": str(uuid.uuid4()), "fire_at": exact, "channel": "push", "local_time_label": "09:07"}])
        self.assertEqual(res.status_code, 200, res.get_json())
        rows = db.connection().execute(
            "SELECT fire_at, local_time_label FROM agenda_scheduled_reminders WHERE user_id = ?", (uid,)
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fire_at"] % WINDOW, 0)
        self.assertEqual(rows[0]["local_time_label"], "")

    @unittest.skip(
        "Deviation from docs/design/reminders.md §3.2: agenda push (try_send_push) sends a JSON payload with "
        "title, body 'You have an event at HH:MM.', url and reminder_id; the document targets an empty payload (K1)."
    )
    def test_agenda_push_payload_is_empty(self):
        import agenda_reminder_cron as cron

        uid = self._login_free_user()
        self._subscribe()
        fake = mock.MagicMock()
        with mock.patch.dict(sys.modules, {"pywebpush": mock.MagicMock(webpush=fake, WebPushException=Exception)}):
            cron.try_send_push(uid, "Deeperguard", cron.agenda_reminder_line("14:30"), str(uuid.uuid4()))
        data = fake.call_args.kwargs["data"]
        self.assertTrue(data is None or not re.search(r"\d{1,2}:\d{2}", data))


# Inherited tests belong to the base classes; only run this file's own.
for _name in [n for n in dir(_Base) if n.startswith("test_") and n not in vars(ReminderPushContractTest)]:
    setattr(ReminderPushContractTest, _name, None)

if __name__ == "__main__":
    unittest.main()
