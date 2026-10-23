"""Round 63: L-17 / L-19 / L-21 / L-22 from SECURITY-REVIEW-2026-10-23."""
from __future__ import annotations

import importlib
import os
import secrets
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
TESTS_DIR = REPO / "tests"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from srp_client_proof import srp_client_proof  # noqa: E402

TURNSTILE_TEST_SITE = "1x00000000000000000000AA"
TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA"
GOOGLE_HOSTS = (
    "accounts.google.com",
    "oauth2.googleapis.com",
    "www.googleapis.com",
)
DROPBOX_HOSTS = (
    "api.dropboxapi.com",
    "content.dropboxapi.com",
    "www.dropbox.com",
)


class Round63SecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round63"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        os.environ.pop("GOOGLE_OAUTH_CLIENT_ID", None)
        os.environ.pop("DROPBOX_APP_KEY", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round63-secret", encoding="utf-8")
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
        for key in (
            "NOTES_TURNSTILE_SITE_KEY",
            "NOTES_TURNSTILE_SECRET_KEY",
            "GOOGLE_OAUTH_CLIENT_ID",
            "DROPBOX_APP_KEY",
        ):
            os.environ.pop(key, None)
        self.tmp.cleanup()

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

    def _create_srp_user(self, email: str, password: str, *, totp: bool = False):
        import db as notes_db
        from passwords import new_kdf_salt

        salt, verifier = self._srp_pair(email, password)
        uid = notes_db.create_user_srp(
            email,
            new_kdf_salt(),
            salt,
            verifier,
            srp_kdf_version=2,
            storage_quota_bytes=10 * 1024 * 1024,
        )
        notes_db.connection().execute(
            "UPDATE users SET email_verified = 1, storage_quota_bytes = ? WHERE id = ?",
            (100 * 1024 * 1024, uid),
        )
        notes_db.connection().commit()
        secret = ""
        if totp:
            import totp as totp_mod

            secret = totp_mod.new_secret()
            notes_db.connection().execute(
                "UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?",
                (secret, uid),
            )
            notes_db.connection().commit()
        return uid, salt, verifier, secret

    def _add_note(self, uid: int, password: str, title: str = "Keep me"):
        import db as notes_db
        from vault_crypto import encrypt_object

        user = notes_db.get_user_by_id(uid)
        ciphertext = encrypt_object(
            password,
            user["kdf_salt"],
            notes_db.user_vault_kdf_version(user),
            {"type": "note", "title": title, "content": "must survive recovery"},
        )
        notes_db.upsert_item(
            uid,
            "round63-keep-note",
            ciphertext,
            1,
            "round63-hash",
            False,
            notes_db.now(),
        )
        return ciphertext

    def _login(self, email: str, password: str):
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        body = challenge.get_json()
        a_hex, m1 = srp_client_proof(
            email, password, body["srp_salt"], body["B"], body.get("srp_kdf_version"),
        )
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )
        return verify

    def _vault_recovery(self, email: str, password: str, csrf: str, *, new_salt: str, new_verifier: str):
        chal = self.client.post(
            "/api/auth/vault-recovery/challenge",
            json={"email": email},
            headers={"X-CSRF-Token": csrf},
        )
        if chal.status_code != 200:
            return chal, None
        body = chal.get_json()
        a_hex, m1 = srp_client_proof(
            email, password, body["srp_salt"], body["B"], body.get("srp_kdf_version"),
        )
        recovered = self.client.post(
            "/api/auth/vault-recovery",
            json={
                "email": email,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 2,
                "A": a_hex,
                "M1": m1,
            },
            headers={"X-CSRF-Token": csrf},
        )
        return chal, recovered

    def test_l22_writer_routes_are_not_public_path(self):
        import auth

        self.assertFalse(auth.public_path("/api/auth/vault-recovery"))
        self.assertFalse(auth.public_path("/api/auth/vault-recovery/challenge"))
        self.assertFalse(auth.public_path("/api/auth/srp/upgrade"))
        self.assertFalse(auth.public_path("/api/auth/srp/kdf-upgrade"))
        self.assertTrue(auth.public_path("/api/auth/srp/resync"))
        self.assertTrue(auth.public_path("/api/auth/repair-login"))

    def test_l22_totp_pending_vault_recovery_403_then_succeeds(self):
        import db as notes_db
        import pyotp
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"l22-{secrets.token_hex(4)}@example.com"
        password = "l22-totp-pending-password"
        uid, stored_salt, stored_verifier, secret = self._create_srp_user(
            email, password, totp=True,
        )
        ciphertext = self._add_note(uid, password)

        login = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertTrue(login.get_json().get("totp_required"))
        csrf = self._csrf()
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)

        chal, recovered = self._vault_recovery(
            email, password, csrf, new_salt=new_salt, new_verifier=new_verifier,
        )
        self.assertEqual(chal.status_code, 403, chal.get_json())
        self.assertEqual(chal.get_json().get("error"), "2FA required")
        self.assertIsNone(recovered)
        user = notes_db.get_user_by_email(email)
        self.assertEqual(str(user["srp_salt"]).lower(), stored_salt.lower())
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(stored_verifier, 16))
        kept = notes_db.list_items_by_uuid(uid, ["round63-keep-note"])
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["ciphertext"], ciphertext)

        verified = self.client.post(
            "/api/totp/verify",
            json={"code": pyotp.TOTP(secret).now()},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())

        chal, recovered = self._vault_recovery(
            email, password, csrf, new_salt=new_salt, new_verifier=new_verifier,
        )
        self.assertEqual(chal.status_code, 200, chal.get_json())
        self.assertEqual(recovered.status_code, 200, recovered.get_json())
        self.assertTrue(recovered.get_json().get("vault_recovered"))
        user = notes_db.get_user_by_email(email)
        self.assertEqual(str(user["srp_salt"]).lower(), new_salt.lower())
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(new_verifier, 16))
        kept = notes_db.list_items_by_uuid(uid, ["round63-keep-note"])
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["ciphertext"], ciphertext)

        follow = self._login(email, password)
        self.assertEqual(follow.status_code, 200, follow.get_json())

    def test_l22_vault_recovery_works_without_2fa(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"l22-no2fa-{secrets.token_hex(4)}@example.com"
        password = "l22-no2fa-password"
        uid, _, _, _ = self._create_srp_user(email, password, totp=False)
        ciphertext = self._add_note(uid, password)
        login = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertFalse(login.get_json().get("totp_required"))
        csrf = self._csrf()
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)
        chal, recovered = self._vault_recovery(
            email, password, csrf, new_salt=new_salt, new_verifier=new_verifier,
        )
        self.assertEqual(chal.status_code, 200, chal.get_json())
        self.assertEqual(recovered.status_code, 200, recovered.get_json())
        self.assertTrue(recovered.get_json().get("vault_recovered"))
        kept = notes_db.list_items_by_uuid(uid, ["round63-keep-note"])
        self.assertEqual(kept[0]["ciphertext"], ciphertext)

    def test_l22_srp_upgrade_and_resync_reject_totp_pending(self):
        import db as notes_db
        from passwords import hash_password

        email = f"l22-upgrade-{secrets.token_hex(4)}@example.com"
        password = "l22-upgrade-password"
        uid, stored_salt, stored_verifier, _ = self._create_srp_user(
            email, password, totp=True,
        )
        notes_db.connection().execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(password), uid),
        )
        notes_db.connection().commit()
        login = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertTrue(login.get_json().get("totp_required"))
        csrf = self._csrf()
        new_salt, new_verifier = self._srp_pair(email, password)
        upgraded = self.client.post(
            "/api/auth/srp/upgrade",
            json={
                "current_password": password,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 2,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(upgraded.status_code, 403, upgraded.get_json())
        self.assertEqual(upgraded.get_json().get("error"), "2FA required")
        resync = self.client.post(
            "/api/auth/srp/resync",
            json={
                "email": email,
                "password": password,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 2,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(resync.status_code, 403, resync.get_json())
        self.assertEqual(resync.get_json().get("error"), "2FA required")
        user = notes_db.get_user_by_id(uid)
        self.assertEqual(str(user["srp_salt"]).lower(), stored_salt.lower())
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(stored_verifier, 16))

        with self.client.session_transaction() as sess:
            sess.clear()
        allowed = self.client.post(
            "/api/auth/srp/resync",
            json={
                "email": email,
                "password": password,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "srp_kdf_version": 2,
            },
        )
        self.assertEqual(allowed.status_code, 200, allowed.get_json())
        self.assertTrue(allowed.get_json().get("srp_resynced"))

    def test_l21_half_configured_turnstile_fails_closed(self):
        import db as notes_db

        email = f"l21-site-{secrets.token_hex(4)}@example.com"
        salt, verifier = self._srp_pair(email, "l21-site-only-password")
        os.environ["NOTES_TURNSTILE_SITE_KEY"] = TURNSTILE_TEST_SITE
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        with patch("urllib.request.urlopen") as mock_open:
            res = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": email,
                    "srp_salt": salt,
                    "srp_verifier": verifier,
                    "srp_kdf_version": 2,
                    "cf_turnstile_response": "dummy-token",
                },
            )
            mock_open.assert_not_called()
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.get_json().get("code"), "turnstile_unavailable")
        self.assertIsNone(notes_db.get_user_by_email(email))

        email2 = f"l21-secret-{secrets.token_hex(4)}@example.com"
        salt2, verifier2 = self._srp_pair(email2, "l21-secret-only-password")
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ["NOTES_TURNSTILE_SECRET_KEY"] = TURNSTILE_TEST_SECRET
        with patch("urllib.request.urlopen") as mock_open:
            res = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": email2,
                    "srp_salt": salt2,
                    "srp_verifier": verifier2,
                    "srp_kdf_version": 2,
                    "cf_turnstile_response": "dummy-token",
                },
            )
            mock_open.assert_not_called()
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.get_json().get("code"), "turnstile_unavailable")
        self.assertIsNone(notes_db.get_user_by_email(email2))

        email3 = f"l21-off-{secrets.token_hex(4)}@example.com"
        salt3, verifier3 = self._srp_pair(email3, "l21-both-unset-password")
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        res = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email3,
                "srp_salt": salt3,
                "srp_verifier": verifier3,
                "srp_kdf_version": 2,
            },
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertIsNotNone(notes_db.get_user_by_email(email3))

    def test_l17_does_not_adopt_another_live_session(self):
        import db as notes_db

        email = f"l17-{secrets.token_hex(4)}@example.com"
        password = "l17-device-password"
        uid, _, _, _ = self._create_srp_user(email, password)
        login = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())

        listed = self.client.get("/api/sessions")
        self.assertEqual(listed.status_code, 200, listed.get_json())
        cookie = next(item for item in listed.get_json()["sessions"] if item["current"])
        other_token = notes_db.create_user_session(
            uid,
            device_label="Linux · Chrome",
            user_agent="Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0",
            device_id="l17-other-device",
            ip="203.0.113.40",
        )
        self.assertTrue(other_token)
        other_row = notes_db.get_session_by_token(other_token)
        self.assertIsNotNone(other_row)
        self.assertNotEqual(int(other_row["id"]), int(cookie["id"]))

        adopted = self.client.get(
            "/api/sessions",
            headers={"X-Device-Id": "l17-other-device"},
        )
        self.assertEqual(adopted.status_code, 200, adopted.get_json())
        current = next(item for item in adopted.get_json()["sessions"] if item["current"])
        self.assertEqual(current["id"], cookie["id"])
        still = notes_db.get_session_by_token(other_token)
        self.assertIsNotNone(still)
        self.assertEqual(int(still["id"]), int(other_row["id"]))
        self.assertEqual(int(still["revoked_at"] or 0), 0)

    def test_l19_csp_omits_google_dropbox_when_keys_empty(self):
        from config import app_entry_path

        os.environ.pop("GOOGLE_OAUTH_CLIENT_ID", None)
        os.environ.pop("DROPBOX_APP_KEY", None)
        for path in (app_entry_path(), "/login", "/"):
            resp = self.client.get(path)
            self.assertEqual(resp.status_code, 200, path)
            csp = resp.headers.get("Content-Security-Policy") or ""
            for host in GOOGLE_HOSTS + DROPBOX_HOSTS:
                self.assertNotIn(host, csp, f"{host} on {path}")

        os.environ["GOOGLE_OAUTH_CLIENT_ID"] = "123.apps.googleusercontent.com"
        os.environ["DROPBOX_APP_KEY"] = "dropbox-app-key"
        app_csp = self.client.get(app_entry_path()).headers.get("Content-Security-Policy") or ""
        for host in GOOGLE_HOSTS + DROPBOX_HOSTS:
            self.assertIn(host, app_csp, host)
        login_csp = self.client.get("/login").headers.get("Content-Security-Policy") or ""
        for host in GOOGLE_HOSTS + DROPBOX_HOSTS:
            self.assertNotIn(host, login_csp, host)


if __name__ == "__main__":
    unittest.main()
