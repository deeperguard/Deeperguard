"""Agenda reminder API: zero-knowledge payload keys and sync caps."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
sys.path.insert(0, str(APP))

_ISOLATED_APP_MODULES = frozenset(
    {
        "app",
        "auth",
        "config",
        "db",
        "srp_auth",
        "auth_rate_limit",
        "plans",
        "mailer",
        "agenda_reminder_cron",
    }
)


def _purge_isolated_app_modules() -> None:
    for name in list(sys.modules):
        if name in _ISOLATED_APP_MODULES or name.startswith("app."):
            sys.modules.pop(name, None)


class AgendaRemindersApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="dg-agenda-rem-")
        os.environ["NOTES_ROOT"] = cls._tmp.name
        os.environ["NOTES_DATA"] = str(Path(cls._tmp.name) / "data")
        os.environ["NOTES_KEYS"] = str(Path(cls._tmp.name) / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "0"
        (Path(cls._tmp.name) / "keys").mkdir(parents=True, exist_ok=True)
        (Path(cls._tmp.name) / "keys" / "flask-secret").write_text("agenda-rem-secret", encoding="utf-8")
        _purge_isolated_app_modules()
        cls.app_mod = importlib.import_module("app")
        cls.client = cls.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()
        for key in (
            "NOTES_ROOT",
            "NOTES_DATA",
            "NOTES_KEYS",
            "NOTES_ALLOWED_CIDRS",
            "NOTES_DISABLE_CIDR_GATE",
            "NOTES_ALLOW_REGISTER",
            "NOTES_SECURE_COOKIES",
        ):
            os.environ.pop(key, None)

    def setUp(self):
        import auth_rate_limit as arl

        arl._hits.clear()  # each test registers its own accounts

    def _csrf_headers(self) -> dict[str, str]:
        import secrets

        with self.client.session_transaction() as sess:
            token = sess.get("csrf") or secrets.token_urlsafe(32)
            sess["csrf"] = token
        return {"X-CSRF-Token": str(token)}

    def _login_free_user(self, verified: bool = True, plan: str = "pro") -> int:
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"rem-{uuid.uuid4().hex[:8]}@e2e.invalid"
        self._last_email = email
        password = "RemindPass1!abc"
        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        reg = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email,
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
            },
        )
        self.assertEqual(reg.status_code, 200, reg.get_json())
        import secrets

        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x, normalize_srp_kdf_version

        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        body = challenge.get_json()
        b_hex = str(body["B"]).lower()
        stored_salt = str(body["srp_salt"]).lower()
        version = normalize_srp_kdf_version(body.get("srp_kdf_version"))
        x = generate_x(stored_salt, email, password, kdf_version=version)
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a_bytes = secrets.token_bytes(byte_len)
            a = int.from_bytes(a_bytes, "big") % N
            if a != 0:
                break
        A = pow(G, a, N)
        a_hex = _to_hex(A)
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        v = pow(G, x, N)
        tmp = (v * K) % N
        S = pow((B - tmp + N) % N, (u * x + a) % N, N)
        s_hex = _to_hex(S)
        m1 = _h(a_hex + b_hex + s_hex)
        proof = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )
        self.assertEqual(proof.status_code, 200, proof.get_json())
        import db

        row = db.connection().execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        uid = int(row["id"])
        db.connection().execute(
            "UPDATE users SET email_verified = ? WHERE id = ?", (1 if verified else 0, uid)
        )
        if plan != "free":
            db.update_user_plan(uid, plan)
        db.connection().commit()
        return uid

    def _sync(self, reminders, delete_ids=()):
        return self.client.post(
            "/api/agenda-reminders/sync",
            headers=self._csrf_headers(),
            json={"reminders": list(reminders), "delete_ids": list(delete_ids)},
        )

    @staticmethod
    def _row(channel="email", offset=3600, label="14:00", rid=None):
        import time

        return {
            "id": rid or str(uuid.uuid4()),
            "fire_at": int(time.time()) + offset,
            "channel": channel,
            "local_time_label": label,
        }

    def _pending(self, uid):
        import db

        return [
            dict(r) for r in db.connection().execute(
                "SELECT id, channel, local_time_label, sent_at FROM agenda_scheduled_reminders WHERE user_id = ?",
                (uid,),
            ).fetchall()
        ]

    def test_free_plan_blocks_agenda_reminder_sync(self):
        self._login_free_user(plan="free")
        res = self._sync([self._row()])
        self.assertEqual(res.status_code, 403, res.get_json())
        body = res.get_json()
        self.assertEqual(body.get("code"), "plan_required")
        self.assertEqual(body.get("required_plan"), "pro")

    def test_push_rows_are_skipped_while_push_is_not_configured(self):
        uid = self._login_free_user()
        os.environ.pop("NOTES_VAPID_PUBLIC_KEY", None)
        os.environ.pop("NOTES_VAPID_PRIVATE_KEY", None)
        res = self._sync([self._row("push"), self._row("email")])
        self.assertEqual(res.status_code, 200, res.get_json())
        body = res.get_json()
        self.assertEqual(body["upserted"], 1)
        self.assertEqual(body["skipped_push"], 1)
        self.assertEqual([r["channel"] for r in self._pending(uid)], ["email"])

    def test_email_rows_need_a_verified_address(self):
        uid = self._login_free_user(verified=False)
        res = self._sync([self._row("email")])
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(res.get_json()["skipped_email"], 1)
        self.assertEqual(self._pending(uid), [])

    def test_time_label_must_be_a_clock_time(self):
        uid = self._login_free_user()
        res = self._sync([self._row(label="Dentist 3pm!!"), self._row(label="09:05")])
        self.assertEqual(res.status_code, 200, res.get_json())
        labels = sorted(r["local_time_label"] for r in self._pending(uid))
        self.assertEqual(labels, ["", "09:05"])

    def test_cap_allows_updates_and_replace_in_one_request(self):
        import db

        uid = self._login_free_user()
        old_cap = db.AGENDA_REMINDER_PENDING_CAP
        db.AGENDA_REMINDER_PENDING_CAP = 3
        try:
            rows = [self._row() for _ in range(3)]
            self.assertEqual(self._sync(rows).get_json()["upserted"], 3)
            over = self._sync([self._row()]).get_json()
            self.assertEqual((over["upserted"], over["rejected_cap"]), (0, 1))
            # Updating existing rows at the cap still works.
            moved = [dict(r, fire_at=r["fire_at"] + 60) for r in rows]
            self.assertEqual(self._sync(moved).get_json()["upserted"], 3)
            # Deleting two and adding two in one request works.
            swap = self._sync([self._row(), self._row()], [rows[0]["id"], rows[1]["id"]]).get_json()
            self.assertEqual((swap["deleted"], swap["upserted"], swap["rejected_cap"]), (2, 2, 0))
            self.assertEqual(len(self._pending(uid)), 3)
        finally:
            db.AGENDA_REMINDER_PENDING_CAP = old_cap

    def test_cron_undeliverable_rows_never_block_other_accounts(self):
        import time

        import agenda_reminder_cron as cron
        import db

        os.environ.pop("NOTES_VAPID_PUBLIC_KEY", None)
        os.environ.pop("NOTES_VAPID_PRIVATE_KEY", None)
        db.connection().execute("DELETE FROM agenda_scheduled_reminders")
        db.connection().commit()
        stuck = self._login_free_user()
        normal = self._login_free_user()
        normal_email = self._last_email
        unverified = self._login_free_user(verified=False)
        t0 = time.time()
        # Rows as an older or hostile client could have left them: written straight to the table.
        db.sync_agenda_reminders(stuck, [
            {"id": str(uuid.uuid4()), "fire_at": t0 + 1 + i * 0.001, "channel": "push", "local_time_label": "09:00"}
            for i in range(60)
        ], [])
        db.sync_agenda_reminders(normal, [
            {"id": str(uuid.uuid4()), "fire_at": t0 + 2, "channel": "email", "local_time_label": "09:00"},
        ], [])
        db.sync_agenda_reminders(unverified, [
            {"id": str(uuid.uuid4()), "fire_at": t0 + 2, "channel": "email", "local_time_label": "09:00"},
        ], [])
        sent = []
        original = cron.send_plain_email
        cron.send_plain_email = lambda to, subject, body: sent.append((to, body))
        try:
            delivered = 0
            for step in range(1, 4):
                delivered += cron.run_agenda_reminders(t0 + 60 * step)
        finally:
            cron.send_plain_email = original
        self.assertEqual(delivered, 1)
        self.assertEqual([to for to, _ in sent], [normal_email])
        self.assertIn("You have an event at 09:00.", sent[0][1])
        left = db.connection().execute(
            "SELECT COUNT(*) AS n FROM agenda_scheduled_reminders WHERE sent_at = 0"
        ).fetchone()["n"]
        self.assertEqual(left, 0)

    def test_cron_does_not_send_reminders_that_are_too_late(self):
        import time

        import agenda_reminder_cron as cron
        import db

        db.connection().execute("DELETE FROM agenda_scheduled_reminders")
        db.connection().commit()
        uid = self._login_free_user()
        t0 = time.time()
        db.sync_agenda_reminders(uid, [
            {"id": str(uuid.uuid4()), "fire_at": t0 + 5, "channel": "email", "local_time_label": "09:00"},
        ], [])
        sent = []
        original = cron.send_plain_email
        cron.send_plain_email = lambda to, subject, body: sent.append(to)
        try:
            self.assertEqual(cron.run_agenda_reminders(t0 + 26 * 3600), 0)
        finally:
            cron.send_plain_email = original
        self.assertEqual(sent, [])
        self.assertEqual([r["sent_at"] > 0 for r in self._pending(uid)], [True])

    def test_push_endpoint_must_be_a_known_push_service(self):
        import agenda_reminder_cron as cron

        self.assertTrue(cron.push_endpoint_allowed("https://fcm.googleapis.com/fcm/send/abc"))
        self.assertTrue(cron.push_endpoint_allowed("https://updates.push.services.mozilla.com/wpush/v2/abc"))
        self.assertTrue(cron.push_endpoint_allowed("https://web.push.apple.com/abc"))
        self.assertTrue(cron.push_endpoint_allowed("https://wns2-am3p.notify.windows.com/w/?token=abc"))
        for bad in (
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://127.0.0.1/",
            "https://localhost:80/admin",
            "https://169.254.169.254/latest/meta-data",
            "https://fcm.googleapis.com.evil.example/x",
            "https://user:pw@fcm.googleapis.com/x",
            "https://fcm.googleapis.com:8443/x",
            "",
        ):
            self.assertFalse(cron.push_endpoint_allowed(bad), bad)
        self._login_free_user()
        os.environ["NOTES_VAPID_PUBLIC_KEY"] = "test-public"
        os.environ["NOTES_VAPID_PRIVATE_KEY"] = "test-private"
        try:
            bad = self.client.post(
                "/api/agenda-reminders/push-subscribe",
                headers=self._csrf_headers(),
                json={"endpoint": "https://127.0.0.1/x", "subscription": {"endpoint": "https://127.0.0.1/x"}},
            )
            self.assertEqual(bad.status_code, 400, bad.get_json())
            ok = self.client.post(
                "/api/agenda-reminders/push-subscribe",
                headers=self._csrf_headers(),
                json={
                    "endpoint": "https://fcm.googleapis.com/fcm/send/abc",
                    "subscription": {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {}},
                },
            )
            self.assertEqual(ok.status_code, 200, ok.get_json())
        finally:
            os.environ.pop("NOTES_VAPID_PUBLIC_KEY", None)
            os.environ.pop("NOTES_VAPID_PRIVATE_KEY", None)

    def test_sync_rejects_plaintext_fields(self):
        self._login_free_user()
        rid = str(uuid.uuid4())
        bad = self.client.post(
            "/api/agenda-reminders/sync",
            headers=self._csrf_headers(),
            json={
                "reminders": [{
                    "id": rid,
                    "fire_at": int(__import__("time").time()) + 3600,
                    "channel": "email",
                    "title": "Secret meeting",
                }],
                "delete_ids": [],
            },
        )
        self.assertEqual(bad.status_code, 400)
        err = bad.get_json().get("error", "")
        self.assertTrue("forbidden" in err or "disallowed" in err, err)

    def test_sync_accepts_minimal_payload(self):
        self._login_free_user()
        rid = str(uuid.uuid4())
        ok = self.client.post(
            "/api/agenda-reminders/sync",
            headers=self._csrf_headers(),
            json={
                "reminders": [{
                    "id": rid,
                    "fire_at": int(__import__("time").time()) + 7200,
                    "channel": "email",
                    "local_time_label": "14:00",
                }],
                "delete_ids": [],
            },
        )
        self.assertEqual(ok.status_code, 200, ok.get_json())
        body = ok.get_json()
        self.assertTrue(body.get("ok"))
        listed = self.client.get("/api/agenda-reminders")
        self.assertEqual(listed.status_code, 200)
        rows = listed.get_json().get("reminders") or []
        self.assertTrue(any(r.get("id") == rid for r in rows))
        keys = set(rows[0].keys())
        self.assertFalse(keys & {"title", "location", "notes", "event_id"})


if __name__ == "__main__":
    unittest.main()
