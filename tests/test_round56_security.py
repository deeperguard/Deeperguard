"""Round 56 security review fixes (C1, H2, M1–M4, Lows)."""
from __future__ import annotations

import importlib
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class Round56SecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round56"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_SERVE_CA_CRT", None)
        os.environ.pop("NOTES_REPAIR_LOGIN_PASSWORD", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round56-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app",
                "config",
                "auth",
                "db",
                "srp_auth",
                "totp",
                "auth_rate_limit",
                "verification_send_limit",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()

    def tearDown(self):
        try:
            import auth_rate_limit as arl

            arl._hits.clear()
        except Exception:
            pass
        self.tmp.cleanup()

    def _srp_pair(self, email: str, password: str, *, kdf_version: int = 2):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=kdf_version)
        return salt, verifier

    def _create_user(self, email: str, password: str, *, kdf_version: int = 2, totp: bool = False):
        import db as notes_db
        from passwords import new_kdf_salt

        salt, verifier = self._srp_pair(email, password, kdf_version=kdf_version)
        uid = notes_db.create_user_srp(
            email,
            new_kdf_salt(),
            salt,
            verifier,
            srp_kdf_version=kdf_version,
        )
        notes_db.mark_email_verified(uid)
        if totp:
            import totp as totp_mod

            secret = totp_mod.new_secret()
            notes_db.connection().execute(
                "UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?",
                (secret, uid),
            )
            notes_db.connection().commit()
            return uid, salt, verifier, secret
        return uid, salt, verifier, None

    def _proof(self, email: str, password: str, challenge_path: str, *, headers=None, kdf_version=None):
        import secrets as sec

        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x, normalize_srp_kdf_version

        challenge = self.client.post(challenge_path, json={"email": email}, headers=headers or {})
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        body = challenge.get_json()
        b_hex = str(body["B"]).lower()
        stored_salt = str(body["srp_salt"]).lower()
        version = normalize_srp_kdf_version(
            kdf_version if kdf_version is not None else body.get("srp_kdf_version")
        )
        x = generate_x(stored_salt, email, password, kdf_version=version)
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a = int.from_bytes(sec.token_bytes(byte_len), "big") % N
            if a:
                break
        a_hex = _to_hex(pow(G, a, N))
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        v = pow(G, x, N)
        S = pow((B - (v * K) % N + N) % N, (u * x + a) % N, N)
        m1 = _h(a_hex + b_hex + _to_hex(S))
        return a_hex, m1, body

    # --- C1 -----------------------------------------------------------------
    def test_c1_repair_login_prove_only_no_rotation(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = "c1@example.com"
        password = "c1-secure-password"
        uid, stored_salt, stored_verifier, secret = self._create_user(
            email, password, totp=True,
        )
        attacker_salt = new_srp_salt_hex()
        attacker_verifier = generate_verifier_hex(attacker_salt, email, password, kdf_version=2)
        a_hex, m1, _ = self._proof(email, password, "/api/auth/repair-login/challenge")
        res = self.client.post(
            "/api/auth/repair-login",
            json={
                "email": email,
                "srp_salt": attacker_salt,
                "srp_verifier": attacker_verifier,
                "srp_kdf_version": 2,
                "A": a_hex,
                "M1": m1,
            },
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertTrue(res.get_json().get("login_repaired"))
        self.assertTrue(res.get_json().get("totp_required"))
        user = notes_db.get_user_by_id(uid)
        self.assertEqual(str(user["srp_salt"]).lower(), stored_salt.lower())
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(stored_verifier, 16))
        # Old password still works for SRP login challenge/verify.
        a2, m2, _ = self._proof(email, password, "/api/auth/srp/challenge")
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a2, "M1": m2},
        )
        self.assertEqual(verify.status_code, 200, verify.get_json())
        self.assertTrue(secret)

    # --- H2 -----------------------------------------------------------------
    def test_h2_vault_recovery_persists_kdf_v2(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = "h2@example.com"
        password = "h2-secure-password"
        uid, _, _, _ = self._create_user(email, password, kdf_version=1)
        self.assertEqual(notes_db.user_srp_kdf_version(notes_db.get_user_by_id(uid)), 1)
        csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(uid)
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = True
            sess["csrf"] = csrf
        headers = {"X-CSRF-Token": csrf}
        # Challenge must succeed before we prove (session + CSRF).
        challenge = self.client.post(
            "/api/auth/vault-recovery/challenge",
            json={"email": email},
            headers=headers,
        )
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        a_hex, m1, _ = self._proof(
            email, password, "/api/auth/vault-recovery/challenge",
            headers=headers, kdf_version=1,
        )
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)
        recovered = self.client.post(
            "/api/auth/vault-recovery",
            json={
                "email": email,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 2,
                "A": a_hex,
                "M1": m1,
                "csrf_token": csrf,
            },
            headers=headers,
        )
        self.assertEqual(recovered.status_code, 200, recovered.get_json())
        user = notes_db.get_user_by_id(uid)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 2)
        # login_user rotated CSRF — refresh for the downgrade probe.
        with self.client.session_transaction() as sess:
            csrf2 = str(sess.get("csrf") or "")
        headers2 = {"X-CSRF-Token": csrf2}
        # Reject v1 downgrade (new challenge + proof after successful recovery).
        a_hex2, m12, _ = self._proof(
            email, password, "/api/auth/vault-recovery/challenge",
            headers=headers2, kdf_version=2,
        )
        downgrade = self.client.post(
            "/api/auth/vault-recovery",
            json={
                "email": email,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 1,
                "A": a_hex2,
                "M1": m12,
                "csrf_token": csrf2,
            },
            headers=headers2,
        )
        self.assertEqual(downgrade.status_code, 400)

    def test_h2_repair_count_helper(self):
        import db as notes_db

        email = "h2count@example.com"
        password = "h2count-secure-password"
        uid, salt, verifier, _ = self._create_user(email, password, kdf_version=1)
        # Simulate pre-fix vault-recovery: v2 verifier left with kdf=1 + password_changed_at.
        notes_db.connection().execute(
            """
            UPDATE users
            SET srp_salt = ?, srp_verifier = ?, srp_kdf_version = 1,
                password_changed_at = ?
            WHERE id = ?
            """,
            (salt, verifier, time.time(), uid),
        )
        notes_db.connection().commit()
        count = notes_db.repair_srp_kdf_v1_lockouts(apply=False)
        self.assertGreaterEqual(count, 1)
        applied = notes_db.repair_srp_kdf_v1_lockouts(apply=True)
        self.assertGreaterEqual(applied, 1)
        user = notes_db.get_user_by_id(uid)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 2)

    # --- M1 -----------------------------------------------------------------
    def test_m1_repair_challenge_unknown_is_200_fake(self):
        unknown = f"missing-{secrets.token_hex(4)}@example.com"
        res = self.client.post("/api/auth/repair-login/challenge", json={"email": unknown})
        self.assertEqual(res.status_code, 200, res.get_json())
        body = res.get_json()
        self.assertIn("srp_salt", body)
        self.assertIn("B", body)
        self.assertEqual(int(body["srp_kdf_version"]), 2)
        self.assertGreaterEqual(len(body["srp_salt"]), 48)

    def test_m1_verify_errors_unified(self):
        email = "m1verify@example.com"
        password = "m1verify-secure-password"
        self._create_user(email, password)
        # Existing user, no prior challenge → same error as unknown.
        missing_state = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": "ab", "M1": "cd"},
        )
        unknown = self.client.post(
            "/api/auth/srp/verify",
            json={"email": "nobody-m1@example.com", "A": "ab", "M1": "cd"},
        )
        self.assertEqual(missing_state.status_code, 401)
        self.assertEqual(unknown.status_code, 401)
        self.assertEqual(missing_state.get_json().get("error"), "invalid credentials")
        self.assertEqual(unknown.get_json().get("error"), "invalid credentials")

    # --- M2 -----------------------------------------------------------------
    def test_m2_account_password_rejects_kdf_v1(self):
        email = "m2@example.com"
        password = "m2-secure-password"
        uid, _, _, _ = self._create_user(email, password)
        csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(uid)
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = True
            sess["csrf"] = csrf
        headers = {"X-CSRF-Token": csrf}
        a_hex, m1, _ = self._proof(
            email, password, "/api/account/password/challenge", headers=headers,
        )
        prove = self.client.post(
            "/api/account/password/prove",
            json={"A": a_hex, "M1": m1, "csrf_token": csrf},
            headers=headers,
        )
        self.assertEqual(prove.status_code, 200, prove.get_json())
        token = prove.get_json().get("rotation_token")
        salt, verifier = self._srp_pair(email, password, kdf_version=1)
        denied = self.client.post(
            "/api/account/password",
            json={
                "rotation_token": token,
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 1,
                "csrf_token": csrf,
            },
            headers=headers,
        )
        self.assertEqual(denied.status_code, 400)
        self.assertIn("srp_kdf_version", denied.get_json().get("error", ""))

    # --- M3 -----------------------------------------------------------------
    def test_m3_register_honeypot_soft_fails(self):
        salt, verifier = self._srp_pair("bot@example.com", "bot-secure-password")
        res = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": "bot@example.com",
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
                "company": "Acme Spam Corp",
            },
        )
        self.assertEqual(res.status_code, 400)
        import db as notes_db

        self.assertIsNone(notes_db.get_user_by_email("bot@example.com"))

    # --- M4 -----------------------------------------------------------------
    def test_m4_totp_rejects_older_step(self):
        import totp as totp_mod

        secret = totp_mod.new_secret()
        now = time.time()
        step = totp_mod.current_step(now)
        # Accept current step.
        code_now = __import__("pyotp").TOTP(secret).at(step * 30)
        ok, used = totp_mod.verify_and_step(secret, code_now, last_step=0)
        self.assertTrue(ok)
        self.assertEqual(used, step)
        # Older window step must fail after a newer step was accepted.
        older = __import__("pyotp").TOTP(secret).at((step - 1) * 30)
        ok2, _ = totp_mod.verify_and_step(secret, older, last_step=used)
        self.assertFalse(ok2)

    # --- L6 ca.crt ----------------------------------------------------------
    def test_ca_crt_disabled_by_default(self):
        res = self.client.get("/ca.crt")
        self.assertEqual(res.status_code, 404)


if __name__ == "__main__":
    unittest.main()
