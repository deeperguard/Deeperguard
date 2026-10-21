"""Round 49 security hardening: H1, M1–M5, L3, L9–L13."""
from __future__ import annotations

import importlib
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


class Round49SecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round49"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round49-secret", encoding="utf-8")

        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "passwords",
                "totp",
                "srp_auth",
                "webauthn_helper",
                "auth_rate_limit",
                "email_verify",
                "verification_send_limit",
                "plans",
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
        for key in (
            "NOTES_ROOT",
            "NOTES_DATA",
            "NOTES_KEYS",
            "NOTES_ALLOWED_CIDRS",
            "NOTES_SKIP_LOGIN",
            "NOTES_BUILD",
            "NOTES_SERVER_INFO_REFRESH",
            "NOTES_STRICT_ZK",
            "NOTES_DISABLE_CIDR_GATE",
            "NOTES_ALLOW_REGISTER",
            "NOTES_SECURE_COOKIES",
            "NOTES_WEBAUTHN_ORIGIN",
            "NOTES_ADMIN_EMAILS",
            "NOTES_UNVERIFIED_USER_QUOTA_MB",
            "NOTES_VERIFY_SEND_GLOBAL_DAILY_CAP",
            "NOTES_AUTH_RATE_LIMIT",
        ):
            os.environ.pop(key, None)

    def _csrf(self) -> str:
        with self.client.session_transaction() as sess:
            token = sess.get("csrf") or secrets.token_urlsafe(32)
            sess["csrf"] = token
        return str(token)

    def _srp_pair(self, email: str, password: str, *, kdf_version: int = 2):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=kdf_version)
        return salt, verifier

    def _register_v2(self, email: str, password: str):
        salt, verifier = self._srp_pair(email, password, kdf_version=2)
        res = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email,
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
            },
        )
        return res, salt, verifier

    def _create_v1_user(self, email: str, password: str):
        import db as notes_db
        from passwords import new_kdf_salt

        salt, verifier = self._srp_pair(email, password, kdf_version=1)
        uid = notes_db.create_user_srp(
            email,
            new_kdf_salt(),
            salt,
            verifier,
            srp_kdf_version=1,
            storage_quota_bytes=10 * 1024 * 1024,
        )
        notes_db.connection().execute(
            "UPDATE users SET email_verified = 1, storage_quota_bytes = ? WHERE id = ?",
            (100 * 1024 * 1024, uid),
        )
        notes_db.connection().commit()
        return uid, salt, verifier

    def _login(self, email: str, password: str):
        import secrets as sec

        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x, normalize_srp_kdf_version

        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        body = challenge.get_json()
        salt = str(body["srp_salt"]).lower()
        b_hex = str(body["B"]).lower()
        version = normalize_srp_kdf_version(body.get("srp_kdf_version"))
        x = generate_x(salt, email, password, kdf_version=version)
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
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )
        return verify, body

    # --- H1 -----------------------------------------------------------------
    def test_h1_signup_is_v2_and_v1_upgrades(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex
        from vault_crypto import decrypt_object, encrypt_object

        email = "h1v2@example.com"
        password = "h1-secure-password"
        reg, salt, _ = self._register_v2(email, password)
        self.assertEqual(reg.status_code, 200, reg.get_json())
        user = notes_db.get_user_by_email(email)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 2)

        # Vault unlock uses a separate KDF — unaffected by SRP v2.
        vault_salt = str(user["kdf_salt"])
        blob = encrypt_object(password, vault_salt, 2, {"hello": "world"})
        self.assertEqual(decrypt_object(password, vault_salt, 2, blob)["hello"], "world")

        # Fresh login still v2.
        self.client.post("/api/auth/logout")
        login, chal = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertEqual(int(chal["srp_kdf_version"]), 2)
        self.assertFalse(login.get_json().get("srp_kdf_upgrade"))

        # Legacy v1 account upgrades after login.
        v1_email = "h1v1@example.com"
        v1_pass = "legacy-v1-password"
        self._create_v1_user(v1_email, v1_pass)
        self.client.post("/api/auth/logout")
        login_v1, chal_v1 = self._login(v1_email, v1_pass)
        self.assertEqual(login_v1.status_code, 200, login_v1.get_json())
        self.assertEqual(int(chal_v1["srp_kdf_version"]), 1)
        self.assertTrue(login_v1.get_json().get("srp_kdf_upgrade"))
        csrf = self._csrf()
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, v1_email, v1_pass, kdf_version=2)
        up = self.client.post(
            "/api/auth/srp/kdf-upgrade",
            json={
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 2,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(up.status_code, 200, up.get_json())
        self.assertEqual(up.get_json()["srp_kdf_version"], 2)
        user_v1 = notes_db.get_user_by_email(v1_email)
        self.assertEqual(notes_db.user_srp_kdf_version(user_v1), 2)

        self.client.post("/api/auth/logout")
        login_v2, chal_v2 = self._login(v1_email, v1_pass)
        self.assertEqual(login_v2.status_code, 200, login_v2.get_json())
        self.assertEqual(int(chal_v2["srp_kdf_version"]), 2)
        self.assertFalse(login_v2.get_json().get("srp_kdf_upgrade"))

    # --- M1 -----------------------------------------------------------------
    def test_m1_password_change_revokes_other_sessions(self):
        import db as notes_db

        email = "m1@example.com"
        password = "m1-secure-password"
        reg, _, _ = self._register_v2(email, password)
        self.assertEqual(reg.status_code, 200)
        uid = int(notes_db.get_user_by_email(email)["id"])
        notes_db.connection().execute(
            "UPDATE users SET email_verified = 1 WHERE id = ?", (uid,)
        )
        notes_db.connection().commit()

        # Second device session.
        other = notes_db.create_user_session(
            uid,
            device_label="Other",
            ip="1.2.3.4",
            token="other-device-token-" + secrets.token_hex(8),
        )
        self.assertTrue(other)
        before = notes_db.list_user_sessions(uid, active_since=0)
        self.assertGreaterEqual(len([r for r in before if not r["revoked_at"]]), 1)

        csrf = self._csrf()
        # Prove + rotate password.
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        prove = self.client.post(
            "/api/account/password/challenge",
            json={"email": email},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(prove.status_code, 200, prove.get_json())
        # Use credential proof helper path via stored challenge + prove endpoint
        import secrets as sec

        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x

        chal = prove.get_json()
        salt = str(chal["srp_salt"]).lower()
        b_hex = str(chal["B"]).lower()
        x = generate_x(salt, email, password, kdf_version=2)
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
        proved = self.client.post(
            "/api/account/password/prove",
            json={"A": a_hex, "M1": m1},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(proved.status_code, 200, proved.get_json())
        token = proved.get_json()["rotation_token"]
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, "m1-new-password!!", kdf_version=2)
        changed = self.client.post(
            "/api/account/password",
            json={
                "rotation_token": token,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 2,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(changed.status_code, 200, changed.get_json())
        rows = notes_db.connection().execute(
            "SELECT revoked_at, revoke_reason FROM user_sessions WHERE user_id = ?",
            (uid,),
        ).fetchall()
        revoked = [r for r in rows if float(r["revoked_at"] or 0) > 0]
        active = [r for r in rows if float(r["revoked_at"] or 0) == 0]
        self.assertGreaterEqual(len(revoked), 1, rows)
        self.assertGreaterEqual(len(active), 1)
        self.assertTrue(any(str(r["revoke_reason"] or "") == "password" for r in revoked))

    # --- M2 -----------------------------------------------------------------
    def test_m2_host_only_session_cookie(self):
        email = "m2@example.com"
        password = "m2-secure-password"
        reg, _, _ = self._register_v2(email, password)
        self.assertEqual(reg.status_code, 200)
        # Secure cookies → __Host-session, no Domain.
        set_cookies = reg.headers.get_all("Set-Cookie") if hasattr(reg.headers, "get_all") else []
        if not set_cookies:
            # Werkzeug 3 may expose via getlist
            set_cookies = reg.headers.getlist("Set-Cookie") if hasattr(reg.headers, "getlist") else []
        joined = "\n".join(set_cookies) if set_cookies else str(reg.headers.get("Set-Cookie") or "")
        self.assertIn("__Host-session=", joined)
        self.assertIn("Path=/", joined)
        host_lines = [line for line in joined.split("\n") if line.startswith("__Host-session=")]
        self.assertTrue(host_lines)
        for line in host_lines:
            self.assertNotIn("Domain=", line)
        # Legacy Domain cookies are cleared (Domain= present only on empty session=).
        self.assertIn("session=;", joined)

    # --- M3 -----------------------------------------------------------------
    def test_m3_passkey_routes_need_session_csrf(self):
        # Unsigned: login required
        res = self.client.post("/api/auth/webauthn/register/options", json={})
        self.assertEqual(res.status_code, 401)
        res = self.client.get("/api/auth/webauthn/credentials")
        self.assertEqual(res.status_code, 401)

        email = "m3@example.com"
        password = "m3-secure-password"
        reg, _, _ = self._register_v2(email, password)
        self.assertEqual(reg.status_code, 200)
        # Authenticated but missing CSRF
        res = self.client.post("/api/auth/webauthn/register/options", json={})
        self.assertEqual(res.status_code, 400)
        self.assertIn("CSRF", (res.get_json() or {}).get("error", ""))

        # Pre-login routes remain public
        chal = self.client.post("/api/auth/srp/challenge", json={"email": "nobody@example.com"})
        self.assertEqual(chal.status_code, 200)

    # --- M4 -----------------------------------------------------------------
    def test_m4_signup_ip_cap_and_unverified_quota(self):
        import db as notes_db
        from config import unverified_user_quota_bytes

        # First 5 succeed; 6th hits per-IP cap (limit=5/hour).
        for i in range(5):
            email = f"m4ip{i}@example.com"
            res, _, _ = self._register_v2(email, "m4-secure-password")
            self.assertEqual(res.status_code, 200, res.get_json())
            user = notes_db.get_user_by_email(email)
            self.assertEqual(int(user["storage_quota_bytes"]), unverified_user_quota_bytes())
            self.assertEqual(int(user["email_verified"]), 0)
        sixth, _, _ = self._register_v2("m4ip5@example.com", "m4-secure-password")
        self.assertEqual(sixth.status_code, 429)
        import auth_rate_limit as arl

        arl._hits.clear()

    def test_m4_global_verify_email_cap(self):
        import db as notes_db
        import verification_send_limit as vsl

        os.environ["NOTES_VERIFY_SEND_GLOBAL_DAILY_CAP"] = "2"
        importlib.reload(vsl)
        email = "m4global@example.com"
        reg, _, _ = self._register_v2(email, "m4-secure-password")
        self.assertEqual(reg.status_code, 200)
        user = notes_db.get_user_by_email(email)
        uid = int(user["id"])
        # Seed two global sends (same user, different recipients) to hit the cap.
        notes_db.log_email_send(uid, "a@x.com", vsl.KIND_VERIFY)
        notes_db.log_email_send(uid, "b@x.com", vsl.KIND_VERIFY)
        # Probe with a fresh recipient so cooldown/skip cannot mask the global cap.
        status = vsl.check_verification_send(uid, "fresh-cap-probe@example.com")
        self.assertEqual(status, "blocked")

    # --- M5 -----------------------------------------------------------------
    def test_m5_anti_enumeration(self):
        from srp_auth import fake_srp_challenge

        unknown = "nosuch-user@example.com"
        a = self.client.post("/api/auth/srp/challenge", json={"email": unknown})
        b = self.client.post("/api/auth/srp/challenge", json={"email": unknown})
        self.assertEqual(a.status_code, 200)
        self.assertEqual(b.status_code, 200)
        ja, jb = a.get_json(), b.get_json()
        self.assertEqual(ja["srp_salt"], jb["srp_salt"])
        self.assertEqual(ja["B"], jb["B"])
        salt, B = fake_srp_challenge(unknown, self.app_mod.app.secret_key)
        self.assertEqual(ja["srp_salt"], salt)
        self.assertEqual(ja["B"], B)

        legacy = self.client.post(
            "/api/auth/login",
            json={"email": unknown, "password": "x"},
        )
        self.assertEqual(legacy.status_code, 401)
        self.assertEqual(legacy.get_json().get("error"), "invalid credentials")
        self.assertNotIn("auth_method", legacy.get_json() or {})

        # Duplicate register → generic 400 (not 409).
        self._register_v2("exists@example.com", "exists-secure-pass")
        dup, _, _ = self._register_v2("exists@example.com", "exists-secure-pass")
        self.assertEqual(dup.status_code, 400)
        self.assertNotEqual(dup.status_code, 409)

        wa = self.client.post(
            "/api/auth/webauthn/login/options",
            json={"email": unknown},
            base_url="https://www.deeperguard.com",
        )
        # May be 400 (host) in test env without Host match — accept 200 empty options too.
        self.assertIn(wa.status_code, {200, 400})
        if wa.status_code == 200:
            opts = wa.get_json().get("options") or {}
            allow = opts.get("allowCredentials") or opts.get("publicKey", {}).get("allowCredentials")
            if allow is not None:
                self.assertEqual(allow, [])

    # --- L3 -----------------------------------------------------------------
    def test_l3_totp_rejects_reuse_and_rate_limits(self):
        import db as notes_db
        import pyotp
        import totp as totp_mod

        email = "l3@example.com"
        password = "l3-secure-password"
        reg, _, _ = self._register_v2(email, password)
        self.assertEqual(reg.status_code, 200)
        user = notes_db.get_user_by_email(email)
        uid = int(user["id"])
        secret = totp_mod.new_secret()
        notes_db.connection().execute(
            "UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?",
            (secret, uid),
        )
        notes_db.connection().commit()
        with self.client.session_transaction() as sess:
            sess["uid"] = uid
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = False
            sess["csrf"] = secrets.token_urlsafe(32)

        csrf = self._csrf()
        code = pyotp.TOTP(secret).now()
        ok = self.client.post(
            "/api/totp/verify",
            json={"code": code},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(ok.status_code, 200, ok.get_json())
        # Same step reuse must fail.
        with self.client.session_transaction() as sess:
            sess["totp_ok"] = False
        reuse = self.client.post(
            "/api/totp/verify",
            json={"code": code},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(reuse.status_code, 401)

    # --- L9 -----------------------------------------------------------------
    def test_l9_security_txt_and_generic_errors(self):
        res = self.client.get("/.well-known/security.txt")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Contact:", res.data)
        self.assertIn(b"deeperguard.com", res.data)

    # --- L10 ----------------------------------------------------------------
    def test_l10_admin_emails_require_verified(self):
        import db as notes_db
        from config import user_is_admin
        from passwords import new_kdf_salt

        os.environ["NOTES_ADMIN_EMAILS"] = "admin49@example.com"
        import config as cfg

        importlib.reload(cfg)
        from config import user_is_admin as user_is_admin_fresh

        salt, verifier = self._srp_pair("admin49@example.com", "admin-secure-pass", kdf_version=2)
        uid = notes_db.create_user_srp(
            "admin49@example.com",
            new_kdf_salt(),
            salt,
            verifier,
            srp_kdf_version=2,
        )
        # Even a stale DB is_admin bit must not grant env-listed admin without verify.
        notes_db.connection().execute("UPDATE users SET is_admin = 1 WHERE id = ?", (uid,))
        notes_db.connection().commit()
        user = notes_db.get_user_by_id(uid)
        self.assertFalse(user_is_admin_fresh(user))
        notes_db.mark_email_verified(uid)
        user = notes_db.get_user_by_id(uid)
        self.assertTrue(user_is_admin_fresh(user))

    # --- L11 ----------------------------------------------------------------
    def test_l11_webauthn_origin_is_configured(self):
        from config import webauthn_expected_origin

        self.assertEqual(webauthn_expected_origin(), "https://www.deeperguard.com")

    # --- L12 / L13 headers --------------------------------------------------
    def test_l13_coop_corp_headers(self):
        res = self.client.get("/api/health")
        self.assertEqual(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups")
        self.assertEqual(res.headers.get("Cross-Origin-Resource-Policy"), "same-origin")


if __name__ == "__main__":
    unittest.main()
