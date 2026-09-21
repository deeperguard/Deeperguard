"""Tests for note time-warning reminders and email cron."""
import importlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

NOTE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _srp_verifier(email: str, password: str) -> tuple[str, str]:
    from srp_auth import generate_verifier_hex, new_srp_salt_hex

    salt_hex = new_srp_salt_hex()
    verifier = generate_verifier_hex(salt_hex, email, password)
    return salt_hex, verifier


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "192"
        os.environ["NOTES_PUBLIC_URL"] = "https://192.168.178.143"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "mailer",
                "warning_cron",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.db = importlib.import_module("db")
        self.warning_cron = importlib.import_module("warning_cron")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()
        for key in (
            "NOTES_ROOT",
            "NOTES_DATA",
            "NOTES_KEYS",
            "NOTES_ALLOWED_CIDRS",
            "NOTES_SKIP_LOGIN",
            "NOTES_BUILD",
            "NOTES_PUBLIC_URL",
        ):
            os.environ.pop(key, None)

    def _csrf(self):
        with self.client.session_transaction() as sess:
            return sess.get("csrf", "")

    def _register(self, email="warn@home.local", password="warn-secure-pass"):
        salt_hex, verifier = _srp_verifier(email, password)
        res = self.client.post(
            "/api/auth/srp/register",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        return {"X-CSRF-Token": self._csrf()}

    def test_upsert_list_and_delete_reminder(self):
        csrf = self._register()
        warn_at = int(time.time()) + 3600
        res = self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": warn_at, "title": "Pay rent"},
            headers=csrf,
        )
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["item_uuid"], NOTE_UUID)
        self.assertNotIn("title", body)
        self.assertEqual(body["sent_at"], 0)
        listed = self.client.get("/api/reminders", headers=csrf)
        self.assertEqual(listed.status_code, 200)
        rows = listed.get_json()["reminders"]
        self.assertEqual(len(rows), 1)
        self.assertNotIn("title", rows[0])
        user = self.db.get_user_by_email("warn@home.local")
        stored = self.db.get_reminder(int(user["id"]), NOTE_UUID)
        self.assertEqual(stored["title"], "", "zero-knowledge: note titles must never reach the server")
        deleted = self.client.delete(f"/api/reminders/{NOTE_UUID}", headers=csrf)
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.get_json()["deleted"])
        empty = self.client.get("/api/reminders", headers=csrf)
        self.assertEqual(empty.get_json()["reminders"], [])

    def test_reminder_requires_auth_and_valid_uuid(self):
        res = self.client.post("/api/reminders", json={"item_uuid": NOTE_UUID, "warn_at": 1})
        self.assertEqual(res.status_code, 401)
        csrf = self._register()
        bad = self.client.post(
            "/api/reminders",
            json={"item_uuid": "not-a-uuid", "warn_at": time.time() + 60, "title": "x"},
            headers=csrf,
        )
        self.assertEqual(bad.status_code, 400)

    def test_iso_warn_at_and_legacy_title_ignored(self):
        csrf = self._register()
        res = self.client.post(
            "/api/reminders",
            json={
                "item_uuid": NOTE_UUID,
                "warn_at": "2030-01-02T03:04:00Z",
                "title": "  Hello\nworld  extra  ",
            },
            headers=csrf,
        )
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertGreater(body["warn_at"], 1_800_000_000)
        user = self.db.get_user_by_email("warn@home.local")
        self.assertEqual(self.db.get_reminder(int(user["id"]), NOTE_UUID)["title"], "")

    def test_schema_scrubs_previously_stored_titles(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": time.time() + 60},
            headers=csrf,
        )
        with self.db.tx() as conn:
            conn.execute("UPDATE note_reminders SET title = 'leaked' WHERE user_id = ?", (uid,))
        self.db.init_schema(self.db.connection())
        self.assertEqual(self.db.get_reminder(uid, NOTE_UUID)["title"], "")

    def test_cron_sends_due_warning_once(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        past = time.time() - 30
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": past, "title": "Call dentist"},
            headers=csrf,
        )
        sent = []

        def fake_send(recipient, subject, body):
            sent.append((recipient, subject, body))

        with patch.object(self.warning_cron, "send_plain_email", side_effect=fake_send):
            first = self.warning_cron.run_warnings(time.time())
            second = self.warning_cron.run_warnings(time.time())
        self.assertEqual(first, 1)
        self.assertEqual(second, 0)
        self.assertEqual(len(sent), 1)
        recipient, subject, body = sent[0]
        self.assertEqual(recipient, "warn@home.local")
        self.assertEqual(subject, "Deeperguard: time warning")
        self.assertNotIn("Call dentist", subject)
        self.assertNotIn("Call dentist", body)
        self.assertIn(f"https://192.168.178.143/?note={NOTE_UUID}", body)
        self.assertIn("Sign in", body)
        self.assertIn("encrypted end-to-end", body)
        row = self.db.get_reminder(int(user["id"]), NOTE_UUID)
        self.assertGreater(row["sent_at"], 0)

    def test_cron_skips_deleted_note(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        past = time.time() - 10
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": past, "title": "Gone"},
            headers=csrf,
        )
        self.db.upsert_item(uid, NOTE_UUID, "cipher", 1, "hash", True, time.time())
        sent = []
        with patch.object(self.warning_cron, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            count = self.warning_cron.run_warnings(time.time())
        self.assertEqual(count, 0)
        self.assertEqual(sent, [])
        row = self.db.get_reminder(uid, NOTE_UUID)
        self.assertGreater(row["sent_at"], 0)

    def test_updating_warn_at_resets_sent(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": time.time() - 5, "title": "Once"},
            headers=csrf,
        )
        with patch.object(self.warning_cron, "send_plain_email"):
            self.warning_cron.run_warnings(time.time())
        self.assertGreater(self.db.get_reminder(uid, NOTE_UUID)["sent_at"], 0)
        later = time.time() + 120
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": later, "title": "Again"},
            headers=csrf,
        )
        row = self.db.get_reminder(uid, NOTE_UUID)
        self.assertEqual(row["sent_at"], 0)

    def test_same_time_or_title_does_not_resend(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        warn_at = int(time.time()) - 30
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": warn_at, "title": "Once"},
            headers=csrf,
        )
        with patch.object(self.warning_cron, "send_plain_email"):
            self.warning_cron.run_warnings(time.time())
        sent_at = self.db.get_reminder(uid, NOTE_UUID)["sent_at"]
        self.assertGreater(sent_at, 0)
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": warn_at, "title": "Once"},
            headers=csrf,
        )
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": warn_at + 15, "title": "Renamed"},
            headers=csrf,
        )
        row = self.db.get_reminder(uid, NOTE_UUID)
        self.assertEqual(row["sent_at"], sent_at)
        sent = []
        with patch.object(self.warning_cron, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            self.assertEqual(self.warning_cron.run_warnings(time.time()), 0)
        self.assertEqual(sent, [])

    def test_claim_makes_overlapping_cron_a_no_op(self):
        csrf = self._register()
        warn_at = time.time() - 10
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": warn_at, "title": "Once"},
            headers=csrf,
        )
        claimed = self.db.claim_due_reminders(time.time())
        self.assertEqual(len(claimed), 1)
        sent = []
        with patch.object(self.warning_cron, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            self.assertEqual(self.warning_cron.run_warnings(time.time()), 0)
        self.assertEqual(sent, [])

    def test_claim_then_same_time_upsert_does_not_reset_sent(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        warn_at = int(time.time()) - 20
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": warn_at, "title": "Once"},
            headers=csrf,
        )
        claimed = self.db.claim_due_reminders(time.time())
        self.assertEqual(len(claimed), 1)
        self.db.mark_reminder_sent(claimed[0]["id"], time.time(), warn_at=warn_at)
        sent_at = self.db.get_reminder(uid, NOTE_UUID)["sent_at"]
        self.assertGreater(sent_at, 0)
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": warn_at, "title": "Once"},
            headers=csrf,
        )
        row = self.db.get_reminder(uid, NOTE_UUID)
        self.assertEqual(row["sent_at"], sent_at)
        sent = []
        with patch.object(self.warning_cron, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            self.assertEqual(self.warning_cron.run_warnings(time.time()), 0)
        self.assertEqual(sent, [])

    def test_smtp_failure_releases_claim_and_retries(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": time.time() - 10, "title": "Retry"},
            headers=csrf,
        )
        with patch.object(self.warning_cron, "send_plain_email", side_effect=RuntimeError("smtp down")):
            self.assertEqual(self.warning_cron.run_warnings(time.time()), 0)
        row = self.db.get_reminder(uid, NOTE_UUID)
        self.assertEqual(row["sent_at"], 0)
        self.assertEqual(row["sending_at"], 0)
        logs = self.db.list_reminder_log(uid)
        self.assertTrue(any(item["status"] == "error" for item in logs))
        sent = []
        with patch.object(self.warning_cron, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            self.assertEqual(self.warning_cron.run_warnings(time.time()), 1)
        self.assertEqual(len(sent), 1)
        self.assertGreater(self.db.get_reminder(uid, NOTE_UUID)["sent_at"], 0)

    def test_reminder_requires_csrf(self):
        self._register()
        res = self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": time.time() + 60, "title": "x"},
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid CSRF token")
        deleted = self.client.delete(f"/api/reminders/{NOTE_UUID}")
        self.assertEqual(deleted.status_code, 400)

    def test_reminders_are_per_user(self):
        csrf_a = self._register("one@home.local")
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": time.time() + 60, "title": "A"},
            headers=csrf_a,
        )
        self.client.post("/api/auth/logout", headers=csrf_a)
        csrf_b = self._register("two@home.local")
        listed = self.client.get("/api/reminders", headers=csrf_b)
        self.assertEqual(listed.get_json()["reminders"], [])

    def test_naive_iso_warn_at_rejected(self):
        csrf = self._register()
        res = self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": "2030-01-02T03:04:00", "title": "x"},
            headers=csrf,
        )
        self.assertEqual(res.status_code, 400)

    def test_email_time_is_rendered_in_local_zone(self):
        os.environ["NOTES_EMAIL_TZ"] = "Europe/Amsterdam"
        try:
            # 2030-01-02T03:04Z == 04:04 CET
            body = self.warning_cron.warning_email_body(1893553440.0, NOTE_UUID)
        finally:
            os.environ.pop("NOTES_EMAIL_TZ", None)
        self.assertIn("04:04 CET", body)
        self.assertIn("(03:04 UTC)", body)

    def test_repeated_smtp_errors_collapse_into_one_log_row(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        self.client.post(
            "/api/reminders",
            json={"item_uuid": NOTE_UUID, "warn_at": time.time() - 10},
            headers=csrf,
        )
        with patch.object(self.warning_cron, "send_plain_email", side_effect=RuntimeError("smtp down")):
            for _ in range(5):
                self.warning_cron.run_warnings(time.time())
        errors = [row for row in self.db.list_reminder_log(uid) if row["status"] == "error"]
        self.assertEqual(len(errors), 1)
        with patch.object(self.warning_cron, "send_plain_email", side_effect=RuntimeError("dns fail")):
            self.warning_cron.run_warnings(time.time())
        errors = [row for row in self.db.list_reminder_log(uid) if row["status"] == "error"]
        self.assertEqual(len(errors), 2)

    def test_reminder_log_is_pruned(self):
        csrf = self._register()
        user = self.db.get_user_by_email("warn@home.local")
        uid = int(user["id"])
        for i in range(self.db.REMINDER_LOG_KEEP_PER_USER + 25):
            self.db.log_reminder(uid, NOTE_UUID, "warn@home.local", "ok", f"n{i}")
        old_cutoff = time.time() - self.db.REMINDER_LOG_MAX_AGE_SEC - 5
        with self.db.tx() as conn:
            conn.execute(
                "UPDATE reminder_log SET created_at = ? WHERE id IN (SELECT id FROM reminder_log ORDER BY id ASC LIMIT 3)",
                (old_cutoff,),
            )
        removed = self.db.prune_reminder_log()
        self.assertGreaterEqual(removed, 25)
        remaining = self.db.list_reminder_log(uid, limit=10_000)
        self.assertLessEqual(len(remaining), self.db.REMINDER_LOG_KEEP_PER_USER)
        self.assertTrue(all(row["created_at"] > old_cutoff for row in remaining))

    def test_deep_link_survives_server_login_redirect(self):
        # Legacy email links used /?note=; root now forwards to /app.
        res = self.client.get(f"/?note={NOTE_UUID}", follow_redirects=False)
        self.assertEqual(res.status_code, 302)
        self.assertIn(f"/app?note={NOTE_UUID}", res.headers["Location"])
        res = self.client.get(f"/totp?note={NOTE_UUID}")
        self.assertEqual(res.status_code, 302)
        self.assertIn(f"/login?note={NOTE_UUID}", res.headers["Location"])
        # Garbage is dropped, never echoed back.
        res = self.client.get("/totp?note=%3Cscript%3E")
        self.assertEqual(res.status_code, 302)
        self.assertNotIn("note=", res.headers["Location"])

    def test_client_forwards_deep_link_after_auth_and_unlock(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        auth_js = (APP_DIR / "static" / "js" / "auth-pages.js").read_text(encoding="utf-8")
        totp_js = (APP_DIR / "static" / "js" / "totp-page.js").read_text(encoding="utf-8")
        self.assertIn("function afterAuthUrl", auth_js)
        self.assertIn("afterAuthUrl('/app')", auth_js)
        self.assertIn("afterAuthUrl('/totp')", auth_js)
        self.assertNotIn("location.href = '/';", auth_js)
        self.assertIn("/app?note=${encodeURIComponent(note)}", totp_js)
        self.assertIn("function openPendingDeepLink", app_js)
        self.assertIn("location.replace(loginUrlWithDeepLink())", app_js)
        # Must retry after unlock/hydrate and after sync, not only at page load.
        paint = app_js[app_js.index("async function paintUnlockUi"):app_js.index("function revealAppShell")]
        self.assertIn("openPendingDeepLink()", paint)
        reload = app_js[app_js.index("async function reloadVault"):app_js.index("async function bootstrapServerSession")]
        self.assertIn("openPendingDeepLink({ final: true })", reload)
        sync_now = app_js[app_js.index("function syncNow"):app_js.index("function requestManualSync")]
        self.assertIn("openPendingDeepLink({ final: true })", sync_now)
        self.assertIn("reconcileReminderSideEffects()", sync_now)

    def test_client_reminder_side_effects_are_queued_not_dropped(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function queueReminderOp", app_js)
        self.assertIn("function reconcileReminderSideEffects", app_js)
        cancel = app_js[app_js.index("function cancelNoteReminder"):app_js.index("function restoreNoteReminder")]
        self.assertIn("noteHasReminder(target)", cancel)
        self.assertIn("queueReminderOp(uuid, 'cancel')", cancel)
        self.assertNotIn(".catch(() => {})", cancel)
        # Zero-knowledge payload: no title leaves the client.
        payload = app_js[app_js.index("function noteReminderPayload"):app_js.index("const REMINDER_PENDING_KEY")]
        self.assertNotIn("title:", payload)


if __name__ == "__main__":
    unittest.main()
