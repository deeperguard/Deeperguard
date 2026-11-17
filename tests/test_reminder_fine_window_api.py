"""Opt-in 5-minute server window for push windows and email reminders (docs/design/finer-reminder-window.md)."""
from __future__ import annotations

import secrets
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_push_windows_api import PushWindowsApiTest as _Base  # noqa: E402

REPO = Path(__file__).resolve().parents[1]


def _fine_start() -> int:
    """A future 5-minute boundary that is not a 15-minute boundary."""
    return (int(time.time()) // 900 + 4) * 900 + 300


class ReminderFineWindowApiTest(_Base):
    # Reuse the isolated app fixture and helpers; the inherited tests are not re-run here.
    def _email_rows(self, uid):
        import db

        return [
            float(r["fire_at"])
            for r in db.connection().execute(
                "SELECT fire_at FROM agenda_scheduled_reminders WHERE user_id = ? ORDER BY fire_at", (uid,)
            ).fetchall()
        ]

    def test_five_minute_window_needs_the_opt_in_field(self):
        self._login_free_user()
        self._subscribe()
        before = len(self._rows())
        w = self._win(_fine_start())
        self.assertEqual(self._put([w]).status_code, 400, "refused without window_sec")
        self.assertEqual(self._put([w], window_sec=900).status_code, 400, "refused with the default size")
        self.assertEqual(len(self._rows()), before)
        res = self._put([w], window_sec=300)
        self.assertEqual(res.status_code, 200, res.get_json())
        rows = [r for r in self._rows() if r["id"] == w["id"]]
        self.assertEqual([r["window_start"] for r in rows], [w["window_start"]])
        # The same upload twice keeps one row.
        self.assertEqual(self._put([w], window_sec=300).status_code, 200)
        self.assertEqual(len([r for r in self._rows() if r["id"] == w["id"]]), 1)

    def test_nothing_finer_than_five_minutes_and_no_other_sizes(self):
        self._login_free_user()
        self._subscribe()
        before = len(self._rows())
        on_minute = self._win(_fine_start() + 60)
        self.assertEqual(self._put([on_minute], window_sec=300).status_code, 400)
        for bad in (60, 1, 0, 600, "300", 300.0, True, None):
            res = self._put([self._win()], window_sec=bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertEqual(res.get_json()["error"], "invalid window_sec")
        self.assertEqual(len(self._rows()), before)

    def test_mixed_windows_in_one_opted_in_upload(self):
        self._login_free_user()
        self._subscribe()
        quarter, fine = self._win(), self._win(_fine_start())
        self.assertEqual(self._put([quarter, fine], window_sec=300).status_code, 200)
        stored = {r["id"]: r["window_start"] for r in self._rows()}
        self.assertEqual(stored[quarter["id"]], quarter["window_start"])
        self.assertEqual(stored[fine["id"]], fine["window_start"])

    def test_due_five_minute_window_is_pushed_empty_and_removed(self):
        import agenda_reminder_cron as cron
        from unittest import mock

        self._login_free_user()
        self._subscribe()
        w = self._win(_fine_start())
        self.assertEqual(self._put([w], window_sec=300).status_code, 200)
        sent = []
        fake = mock.MagicMock()
        fake.webpush = lambda **kw: sent.append(kw)
        fake.WebPushException = Exception
        mine = lambda: [r for r in self._rows() if r["id"] == w["id"]]  # noqa: E731
        with mock.patch.dict(sys.modules, {"pywebpush": fake}):
            cron.run_push_windows(w["window_start"] - 1)
            self.assertEqual(len(mine()), 1, "not sent before its window starts")
            before = len(sent)
            self.assertGreaterEqual(cron.run_push_windows(w["window_start"] + 1), 1)
        self.assertEqual([kw["data"] for kw in sent[before:]], [None], "one empty push")
        self.assertEqual(mine(), [])

    def test_email_is_rounded_to_five_minutes_only_with_the_opt_in(self):
        uid = self._login_free_user()
        base = (int(time.time()) // 900 + 4) * 900
        exact = base + 7 * 60 + 13
        res = self.client.post(
            "/api/agenda-reminders/sync",
            headers=self._hdr(),
            json={"reminders": [{"id": str(uuid.uuid4()), "fire_at": exact, "channel": "email"}], "delete_ids": []},
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(self._email_rows(uid), [float(base)])
        res = self.client.post(
            "/api/agenda-reminders/sync",
            headers=self._hdr(),
            json={
                "reminders": [{"id": str(uuid.uuid4()), "fire_at": exact, "channel": "email"}],
                "delete_ids": [],
                "window_sec": 300,
            },
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(self._email_rows(uid), [float(base), float(base + 300)])

    def test_email_sync_rejects_other_window_sizes_without_writing(self):
        uid = self._login_free_user()
        exact = (int(time.time()) // 900 + 4) * 900 + 7 * 60 + 13
        for bad in (60, 1, "300", True):
            res = self.client.post(
                "/api/agenda-reminders/sync",
                headers=self._hdr(),
                json={
                    "reminders": [{"id": str(uuid.uuid4()), "fire_at": exact, "channel": "email"}],
                    "delete_ids": [],
                    "window_sec": bad,
                },
            )
            self.assertEqual(res.status_code, 400, bad)
        self.assertEqual(self._email_rows(uid), [])


class ReminderFineWindowClientTest(unittest.TestCase):
    def test_client_uploads(self):
        proc = subprocess.run(
            ["node", str(REPO / "tests" / "test_reminder_fine_window.js")],
            cwd=REPO, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


# Inherited tests belong to the base classes; only run this file's own.
for _name in [n for n in dir(_Base) if n.startswith("test_") and n not in vars(ReminderFineWindowApiTest)]:
    setattr(ReminderFineWindowApiTest, _name, None)
del _Base  # not collected a second time from this module

if __name__ == "__main__":
    unittest.main()
