"""Round 76: automatic legacy Argon2 → SRP upgrade after successful login."""
from __future__ import annotations

import importlib.util
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
TESTS_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


class Round76LegacySrpUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round76"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_REPAIR_LOGIN_PASSWORD"] = "0"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ.pop("NOTES_AUTH_RATE_LIMIT", None)
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round76-secret", encoding="utf-8")

        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "passwords",
                "totp",
                "srp_auth",
                "auth_rate_limit",
                "deeperguard_app",
                "email_verify",
                "plans",
            } or name.startswith("app."):
                sys.modules.pop(name, None)

        spec = importlib.util.spec_from_file_location(
            "deeperguard_app", APP_DIR / "app.py",
        )
        self.app_mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["deeperguard_app"] = self.app_mod
        spec.loader.exec_module(self.app_mod)
        import auth_rate_limit as arl
        import db as notes_db
        from passwords import hash_password, new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        arl._hits.clear()
        self.notes_db = notes_db
        self.hash_password = hash_password
        self.new_kdf_salt = new_kdf_salt
        self.generate_verifier_hex = generate_verifier_hex
        self.new_srp_salt_hex = new_srp_salt_hex
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def _register_legacy(self, email: str, password: str) -> int:
        kdf_salt = self.new_kdf_salt()
        uid = self.notes_db.create_user(email, self.hash_password(password), kdf_salt)
        return int(uid)

    def _srp_pair(self, email: str, password: str):
        salt = self.new_srp_salt_hex()
        verifier = self.generate_verifier_hex(salt, email, password, kdf_version=2)
        return salt, verifier

    def _csrf(self) -> str:
        with self.client.session_transaction() as sess:
            token = sess.get("csrf") or secrets.token_urlsafe(16)
            sess["csrf"] = token
            return token

    def test_legacy_login_upgrades_and_second_login_uses_srp(self):
        email = "r76-upgrade@home.local"
        password = "r76-upgrade-secure-pass"
        uid = self._register_legacy(email, password)
        before = self.notes_db.get_user_by_id(uid)
        kdf_before = str(before["kdf_salt"])
        vault_ver_before = int(before["vault_kdf_version"] or 1)

        login = self.client.post(
            "/api/auth/login", json={"email": email, "password": password},
        )
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.get_json().get("auth_method"), "argon2")
        csrf = self._csrf()
        salt, verifier = self._srp_pair(email, password)
        up = self.client.post(
            "/api/auth/srp/upgrade",
            json={
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(up.status_code, 200)
        self.assertEqual(up.get_json().get("auth_method"), "srp")

        after = self.notes_db.get_user_by_id(uid)
        self.assertEqual(self.notes_db.user_auth_method(after), "srp")
        self.assertEqual(str(after["kdf_salt"]), kdf_before)
        self.assertEqual(int(after["vault_kdf_version"] or 1), vault_ver_before)
        events = self.notes_db.list_auth_events(uid, event="srp_legacy_upgrade")
        self.assertGreaterEqual(len(events), 1)

        # Plaintext login refused after upgrade (R73).
        with self.client.session_transaction() as sess:
            sess.clear()
        refused = self.client.post(
            "/api/auth/login", json={"email": email, "password": password},
        )
        self.assertEqual(refused.status_code, 401)

        # Second login uses SRP proofs (client-side Thinbus math).
        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x

        ch = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(ch.status_code, 200)
        data = ch.get_json()
        stored_salt = str(data["srp_salt"]).lower()
        b_hex = str(data["B"]).lower()
        x = generate_x(stored_salt, email, password, kdf_version=2)
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a = int.from_bytes(secrets.token_bytes(byte_len), "big") % N
            if a:
                break
        a_hex = _to_hex(pow(G, a, N))
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        S = pow(B - (K * pow(G, x, N)) % N, a + u * x, N)
        m1 = _h(a_hex + b_hex + _to_hex(S))
        ver = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )
        self.assertEqual(ver.status_code, 200)
        self.assertEqual(ver.get_json().get("auth_method"), "srp")
        self.assertEqual(ver.get_json().get("kdf_salt"), kdf_before)

    def test_upgrade_rejected_unauthenticated_already_srp_and_stale_totp(self):
        email = "r76-reject@home.local"
        password = "r76-reject-secure-pass"
        self._register_legacy(email, password)
        salt, verifier = self._srp_pair(email, password)
        anon = self.client.post(
            "/api/auth/srp/upgrade",
            json={"srp_salt": salt, "srp_verifier": verifier, "srp_kdf_version": 2},
        )
        self.assertEqual(anon.status_code, 401)

        self.client.post("/api/auth/login", json={"email": email, "password": password})
        csrf = self._csrf()
        ok = self.client.post(
            "/api/auth/srp/upgrade",
            json={"srp_salt": salt, "srp_verifier": verifier, "srp_kdf_version": 2},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(ok.status_code, 200)
        again = self.client.post(
            "/api/auth/srp/upgrade",
            json={"srp_salt": salt, "srp_verifier": verifier, "srp_kdf_version": 2},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(again.status_code, 409)

        # TOTP-pending session cannot upgrade.
        email2 = "r76-totp@home.local"
        password2 = "r76-totp-secure-pass"
        uid2 = self._register_legacy(email2, password2)
        self.notes_db.update_user_totp(uid2, "JBSWY3DPEHPK3PXP", True)
        with self.client.session_transaction() as sess:
            sess.clear()
        login2 = self.client.post(
            "/api/auth/login", json={"email": email2, "password": password2},
        )
        self.assertEqual(login2.status_code, 200)
        self.assertTrue(login2.get_json().get("totp_required"))
        csrf2 = self._csrf()
        salt2, ver2 = self._srp_pair(email2, password2)
        pending = self.client.post(
            "/api/auth/srp/upgrade",
            json={"srp_salt": salt2, "srp_verifier": ver2, "srp_kdf_version": 2},
            headers={"X-CSRF-Token": csrf2},
        )
        self.assertEqual(pending.status_code, 403)
        still = self.notes_db.get_user_by_id(uid2)
        self.assertEqual(self.notes_db.user_auth_method(still), "argon2")

    def test_failed_upgrade_leaves_legacy_usable(self):
        email = "r76-fail@home.local"
        password = "r76-fail-secure-pass"
        uid = self._register_legacy(email, password)
        self.client.post("/api/auth/login", json={"email": email, "password": password})
        csrf = self._csrf()
        bad = self.client.post(
            "/api/auth/srp/upgrade",
            json={"srp_salt": "", "srp_verifier": "", "srp_kdf_version": 2},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(bad.status_code, 400)
        user = self.notes_db.get_user_by_id(uid)
        self.assertEqual(self.notes_db.user_auth_method(user), "argon2")
        # Still signed in (session intact) and legacy login still works after clear.
        me = self.client.get("/api/account", headers={"X-CSRF-Token": csrf})
        self.assertEqual(me.status_code, 200)
        with self.client.session_transaction() as sess:
            sess.clear()
        again = self.client.post(
            "/api/auth/login", json={"email": email, "password": password},
        )
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.get_json().get("auth_method"), "argon2")


if __name__ == "__main__":
    unittest.main()
