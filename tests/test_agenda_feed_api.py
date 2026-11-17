"""Opt-in webcal feed of one calendar: consent, revocable token, public read without a session."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_agenda_reminders_api import AgendaRemindersApiTest as _Base  # noqa: E402

ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
CAL = "a6da67da-67da-4000-8000-0000000000ca"


class AgendaFeedApiTest(_Base):
    # Reuse the isolated app fixture and login helper; the inherited tests are not the subject here.
    def _post(self, path, **body):
        return self.client.post(path, headers=self._csrf_headers(), json=body)

    def _create(self, ics=ICS, cal=CAL):
        return self._post("/api/agenda/feeds", calendar_id=cal, ics=ics, acknowledged=True)

    @staticmethod
    def _path(url):
        return "/" + url.split("/", 3)[3]

    def _anon(self):
        return self.app_mod.app.test_client()

    def test_feed_requires_login(self):
        anon = self._anon()
        res = anon.post("/api/agenda/feeds", json={"calendar_id": CAL, "ics": ICS, "acknowledged": True})
        self.assertIn(res.status_code, (400, 401, 404))
        self.assertEqual(anon.get("/api/agenda/feeds").status_code, 401)

    def test_requires_explicit_consent(self):
        self._login_free_user()
        self.assertEqual(self._post("/api/agenda/feeds", calendar_id=CAL, ics=ICS).status_code, 400)
        res = self._post("/api/agenda/feeds", calendar_id=CAL, ics=ICS, acknowledged="yes")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.get("/api/agenda/feeds").get_json()["feeds"], [])

    def test_public_feed_serves_ics_without_session_and_stores_only_a_hash(self):
        self._login_free_user()
        url = self._create().get_json()["url"]
        self.assertIn("/agenda-feed/", url)
        import db

        stored = db.connection().execute("SELECT token_hash FROM agenda_feeds").fetchone()[0]
        token = url.rsplit("/", 1)[1][: -len(".ics")]
        self.assertNotEqual(stored, token)
        self.assertNotIn(token, stored)
        anon = self._anon()
        res = anon.get(self._path(url))
        self.assertEqual(res.status_code, 200)
        self.assertIn("Dentist", res.get_data(as_text=True))
        self.assertTrue(res.headers["Content-Type"].startswith("text/calendar"))
        self.assertEqual(res.headers["Cache-Control"], "no-store")
        self.assertNotIn("Set-Cookie", res.headers)
        self.assertEqual(anon.get("/agenda-feed/" + "x" * 43 + ".ics").status_code, 404)

    def test_update_changes_content_and_new_link_revokes_old_one(self):
        self._login_free_user()
        url1 = self._create().get_json()["url"]
        new = ICS.replace("Dentist", "Doctor")
        self.assertEqual(self._post("/api/agenda/feeds/update", calendar_id=CAL, ics=new).status_code, 200)
        anon = self._anon()
        self.assertIn("Doctor", anon.get(self._path(url1)).get_data(as_text=True))
        url2 = self._create().get_json()["url"]
        self.assertNotEqual(url1, url2)
        self.assertEqual(anon.get(self._path(url1)).status_code, 404)
        self.assertEqual(anon.get(self._path(url2)).status_code, 200)
        self.assertEqual(len(self.client.get("/api/agenda/feeds").get_json()["feeds"]), 1)

    def test_delete_revokes_and_second_delete_is_harmless(self):
        self._login_free_user()
        url = self._create().get_json()["url"]
        res = self._post("/api/agenda/feeds/delete", calendar_id=CAL)
        self.assertIs(res.get_json()["deleted"], True)
        self.assertEqual(self._anon().get(self._path(url)).status_code, 404)
        res = self._post("/api/agenda/feeds/delete", calendar_id=CAL)
        self.assertEqual((res.status_code, res.get_json()["deleted"]), (200, False))
        self.assertEqual(self._post("/api/agenda/feeds/update", calendar_id=CAL, ics=ICS).status_code, 404)

    def test_rejects_bad_input_and_oversize(self):
        self._login_free_user()
        for body in (
            {"calendar_id": "bad id!", "ics": ICS},
            {"calendar_id": CAL, "ics": "not a calendar"},
            {"calendar_id": CAL, "ics": ICS, "extra": 1},
            {"calendar_id": CAL, "ics": 5},
        ):
            self.assertEqual(self._post("/api/agenda/feeds", acknowledged=True, **body).status_code, 400, body)
        big = ICS + "X" * (2 * 1024 * 1024)
        self.assertEqual(self._create(ics=big).status_code, 413)
        self.assertEqual(self.client.get("/api/agenda/feeds").get_json()["feeds"], [])


if __name__ == "__main__":
    unittest.main()
