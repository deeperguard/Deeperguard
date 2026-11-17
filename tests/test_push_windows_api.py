"""Opt-in closed-app reminders: a random id and a 15-minute window, nothing else."""
from __future__ import annotations

import os
import secrets
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_agenda_reminders_api import AgendaRemindersApiTest as _Base  # noqa: E402

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc"


class PushWindowsHelpers:
    # Request helpers for the push-window tests. The app fixture comes from the class that mixes this in.
    def _hdr(self):
        return self._csrf_headers()

    def _subscribe(self):
        os.environ["NOTES_VAPID_PUBLIC_KEY"] = "pub"
        os.environ["NOTES_VAPID_PRIVATE_KEY"] = "priv"
        res = self.client.post(
            "/api/agenda-reminders/push-subscribe",
            headers=self._hdr(),
            json={"endpoint": ENDPOINT, "subscription": {"endpoint": ENDPOINT, "keys": {}}},
        )
        self.assertEqual(res.status_code, 200, res.get_json())

    def _put(self, windows, endpoint=ENDPOINT, **extra):
        return self.client.post(
            "/api/push-windows",
            headers=self._hdr(),
            json={"endpoint": endpoint, "windows": windows, **extra},
        )

    @staticmethod
    def _win(start=None):
        start = start if start is not None else (int(time.time()) // 900 + 4) * 900
        return {"id": secrets.token_hex(16), "window_start": start}

    def _rows(self):
        import db

        return [dict(r) for r in db.connection().execute("SELECT * FROM push_reminder_windows").fetchall()]

class PushWindowsApiTest(PushWindowsHelpers, _Base):
    def test_schema_has_exactly_the_claimed_columns(self):
        import db

        cols = [r["name"] for r in db.connection().execute("PRAGMA table_info(push_reminder_windows)")]
        self.assertEqual(sorted(cols), sorted(["id", "user_id", "device_id", "window_start", "created_at"]))

    def test_stores_window_and_rejects_bad_input_without_writing(self):
        self._login_free_user()
        self._subscribe()
        before = len(self._rows())
        for bad in (
            [{"id": secrets.token_hex(16), "window_start": 1_900_000_001}],  # not a multiple of 900
            [{"id": "not-hex", "window_start": 900}],
            [{"id": secrets.token_hex(16), "window_start": 900, "title": "x"}],
            [{"id": secrets.token_hex(16), "window_start": 900.0}],
            [{"id": secrets.token_hex(16), "window_start": True}],
        ):
            self.assertEqual(self._put(bad).status_code, 400, bad)
        self.assertEqual(self._put([self._win()], title="x").status_code, 400)
        self.assertEqual(len(self._rows()), before)
        w = self._win()
        self.assertEqual(self._put([w]).status_code, 200)
        rows = [r for r in self._rows() if r["id"] == w["id"]]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["window_start"], w["window_start"])

    def test_unknown_device_cap_and_plan(self):
        self._login_free_user()
        self.assertEqual(self._put([self._win()]).status_code, 404)
        self._subscribe()
        import db

        res = self._put([self._win() for _ in range(db.PUSH_WINDOW_CAP)])
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(self._put([self._win()]).status_code, 400)
        self._login_free_user(plan="free")
        self.assertEqual(self._put([self._win()]).status_code, 403)

    def test_delete_by_id_and_by_device_and_cascade(self):
        uid = self._login_free_user()
        self._subscribe()
        a, b = self._win(), self._win()
        self.assertEqual(self._put([a, b]).status_code, 200)
        res = self.client.post("/api/push-windows/delete", headers=self._hdr(), json={"ids": [a["id"]]})
        self.assertEqual(res.get_json()["deleted"], 1)
        res = self.client.post("/api/push-windows/delete", headers=self._hdr(), json={"endpoint": ENDPOINT})
        self.assertEqual(res.get_json()["deleted"], 1)
        self.assertEqual(self._rows(), [])
        self.assertEqual(self._put([a]).status_code, 200)
        import db

        db.delete_web_push_subscription(uid, ENDPOINT)
        self.assertEqual(self._rows(), [])

    def test_unsubscribe_forgets_device_and_its_windows(self):
        import db

        uid = self._login_free_user()
        self._subscribe()
        self.assertEqual(self._put([self._win()]).status_code, 200)
        url = "/api/agenda-reminders/push-unsubscribe"
        self.assertEqual(self.client.post(url, headers=self._hdr(), json={}).status_code, 400)
        self.assertEqual(
            self.client.post(url, headers=self._hdr(), json={"endpoint": ENDPOINT, "x": 1}).status_code, 400
        )
        for _ in range(2):  # the same action twice stays ok
            res = self.client.post(url, headers=self._hdr(), json={"endpoint": ENDPOINT})
            self.assertEqual(res.status_code, 200)
        self.assertEqual(db.list_web_push_subscriptions(uid), [])
        self.assertEqual([r for r in self._rows() if r["user_id"] == uid], [])
        self.assertEqual(self._put([self._win()]).status_code, 404)

    def test_sender_pushes_empty_payload_and_deletes_row(self):
        import agenda_reminder_cron as cron

        uid = self._login_free_user()
        self._subscribe()
        start = (int(time.time()) // 900) * 900 - 900
        w = self._win(start)
        self.assertEqual(self._put([w]).status_code, 200)
        fake = mock.MagicMock()
        with mock.patch.dict(sys.modules, {"pywebpush": mock.MagicMock(webpush=fake, WebPushException=Exception)}):
            n = cron.run_push_windows(start + 901)
        self.assertEqual(n, 1)
        self.assertIsNone(fake.call_args.kwargs["data"])
        self.assertNotIn("headers", fake.call_args.kwargs)
        self.assertEqual([r for r in self._rows() if r["user_id"] == uid], [])

    def test_window_beyond_expiry_horizon_is_rejected_without_writing(self):
        import db

        uid = self._login_free_user()
        self._subscribe()
        now = int(time.time())
        last_ok = (now + db.PUSH_WINDOW_MAX_AHEAD_SEC) // 900 * 900
        too_far = last_ok + 900
        ok_win = self._win(last_ok)
        # One bad window in a batch rejects the whole batch.
        self.assertEqual(self._put([ok_win, self._win(too_far)]).status_code, 400)
        self.assertEqual(self._put([self._win(900 * 10**8)]).status_code, 400)
        self.assertEqual([r for r in self._rows() if r["user_id"] == uid], [])
        self.assertEqual(self._put([ok_win]).status_code, 200)
        self.assertEqual([r["id"] for r in self._rows() if r["user_id"] == uid], [ok_win["id"]])
        # Moving an existing window past the horizon is rejected too and keeps the old value.
        self.assertEqual(self._put([{"id": ok_win["id"], "window_start": too_far}]).status_code, 400)
        self.assertEqual([r["window_start"] for r in self._rows() if r["user_id"] == uid], [last_ok])

    def test_downgrade_drops_pending_windows_of_that_account_only(self):
        import db

        other = self._login_free_user()
        self._subscribe()
        self.assertEqual(self._put([self._win()]).status_code, 200)
        uid = self._login_free_user()
        self._subscribe()
        self.assertEqual(self._put([self._win(), self._win()]).status_code, 200)
        plan = db.get_user_by_id(uid)["plan"]
        db.update_user_plan(uid, plan)  # same plan: windows stay
        self.assertEqual(len([r for r in self._rows() if r["user_id"] == uid]), 2)
        for _ in range(2):  # downgrading twice is harmless
            db.update_user_plan(uid, "free")
        self.assertEqual([r for r in self._rows() if r["user_id"] == uid], [])
        self.assertEqual(len([r for r in self._rows() if r["user_id"] == other]), 1)

    def test_overdue_window_is_deleted_unsent(self):
        import agenda_reminder_cron as cron

        uid = self._login_free_user()
        self._subscribe()
        w = self._win(900 * 1000)
        self.assertEqual(self._put([w]).status_code, 200)
        fake = mock.MagicMock()
        with mock.patch.dict(sys.modules, {"pywebpush": mock.MagicMock(webpush=fake, WebPushException=Exception)}):
            self.assertEqual(cron.run_push_windows(), 0)
        fake.assert_not_called()
        self.assertEqual([r for r in self._rows() if r["user_id"] == uid], [])


# Inherited tests belong to the base class; only run this file's own.
for _name in [n for n in dir(_Base) if n.startswith("test_") and n not in vars(PushWindowsApiTest)]:
    setattr(PushWindowsApiTest, _name, None)

if __name__ == "__main__":
    unittest.main()
