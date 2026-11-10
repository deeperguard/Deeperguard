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

    def _csrf_headers(self) -> dict[str, str]:
        import secrets

        with self.client.session_transaction() as sess:
            token = sess.get("csrf") or secrets.token_urlsafe(32)
            sess["csrf"] = token
        return {"X-CSRF-Token": str(token)}

    def _login_free_user(self) -> None:
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"rem-{uuid.uuid4().hex[:8]}@e2e.invalid"
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
                    "channel": "push",
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
