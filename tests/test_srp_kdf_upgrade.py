"""M-3: SRP kdf-upgrade requires a fresh current-password proof."""
from __future__ import annotations

import importlib
import os
import secrets
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
REPO = Path(__file__).resolve().parents[1]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from srp_client_proof import srp_client_proof  # noqa: E402


class SrpKdfUpgradeProofTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "kdf-upgrade-m3"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("kdf-upgrade-m3-secret", encoding="utf-8")

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
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        body = challenge.get_json()
        a_hex, m1 = srp_client_proof(
            email,
            password,
            body["srp_salt"],
            body["B"],
            body.get("srp_kdf_version"),
        )
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )
        return verify, body

    def _upgrade_challenge(self, csrf: str, email: str | None = None):
        return self.client.post(
            "/api/auth/srp/kdf-upgrade/challenge",
            json={"email": email} if email else {},
            headers={"X-CSRF-Token": csrf},
        )

    def _upgrade(self, csrf: str, **body):
        return self.client.post(
            "/api/auth/srp/kdf-upgrade",
            json=body,
            headers={"X-CSRF-Token": csrf},
        )

    def test_no_proof_rejected(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"m3-noproof-{secrets.token_hex(4)}@example.com"
        password = "m3-no-proof-password"
        self._create_v1_user(email, password)
        login, _ = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertTrue(login.get_json().get("srp_kdf_upgrade"))

        csrf = self._csrf()
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)
        up = self._upgrade(
            csrf,
            srp_salt=new_salt,
            srp_verifier=new_verifier,
            srp_kdf_version=2,
        )
        self.assertEqual(up.status_code, 400, up.get_json())
        self.assertEqual(up.get_json().get("error"), "missing srp proof")
        user = notes_db.get_user_by_email(email)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 1)

    def test_valid_proof_upgrades_and_v2_login_works(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"m3-ok-{secrets.token_hex(4)}@example.com"
        password = "m3-valid-proof-password"
        self._create_v1_user(email, password)
        user = notes_db.get_user_by_email(email)
        before = notes_db.user_password_changed_at(user)

        login, _ = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        csrf = self._csrf()
        chal = self._upgrade_challenge(csrf, email)
        self.assertEqual(chal.status_code, 200, chal.get_json())
        chal_body = chal.get_json()
        self.assertEqual(int(chal_body["srp_kdf_version"]), 1)

        a_hex, m1 = srp_client_proof(
            email, password, chal_body["srp_salt"], chal_body["B"], chal_body.get("srp_kdf_version"),
        )
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)
        up = self._upgrade(
            csrf,
            srp_salt=new_salt,
            srp_verifier=new_verifier,
            srp_kdf_version=2,
            A=a_hex,
            M1=m1,
        )
        self.assertEqual(up.status_code, 200, up.get_json())
        self.assertEqual(up.get_json()["srp_kdf_version"], 2)
        self.assertTrue(up.get_json().get("M2"))

        user = notes_db.get_user_by_email(email)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 2)
        self.assertEqual(notes_db.user_password_changed_at(user), before)

        self.client.post("/api/auth/logout")
        login_v2, chal_v2 = self._login(email, password)
        self.assertEqual(login_v2.status_code, 200, login_v2.get_json())
        self.assertEqual(int(chal_v2["srp_kdf_version"]), 2)
        self.assertFalse(login_v2.get_json().get("srp_kdf_upgrade"))

    def test_replayed_challenge_rejected(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"m3-replay-{secrets.token_hex(4)}@example.com"
        password = "m3-replay-password"
        uid, old_salt, old_verifier = self._create_v1_user(email, password)
        login, _ = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        csrf = self._csrf()
        chal = self._upgrade_challenge(csrf, email)
        self.assertEqual(chal.status_code, 200, chal.get_json())
        chal_body = chal.get_json()
        a_hex, m1 = srp_client_proof(
            email, password, chal_body["srp_salt"], chal_body["B"], chal_body.get("srp_kdf_version"),
        )
        first_salt = new_srp_salt_hex()
        first_verifier = generate_verifier_hex(first_salt, email, password, kdf_version=2)
        first = self._upgrade(
            csrf,
            srp_salt=first_salt,
            srp_verifier=first_verifier,
            srp_kdf_version=2,
            A=a_hex,
            M1=m1,
        )
        self.assertEqual(first.status_code, 200, first.get_json())

        # Restore v1 so a replay is not masked by the already-upgraded check.
        notes_db.update_user_srp_verifier(
            uid,
            old_salt,
            old_verifier,
            srp_kdf_version=1,
            touch_password_changed=False,
        )
        replay_salt = new_srp_salt_hex()
        replay_verifier = generate_verifier_hex(replay_salt, email, password, kdf_version=2)
        replay = self._upgrade(
            csrf,
            srp_salt=replay_salt,
            srp_verifier=replay_verifier,
            srp_kdf_version=2,
            A=a_hex,
            M1=m1,
        )
        self.assertIn(replay.status_code, {400, 403}, replay.get_json())
        user = notes_db.get_user_by_email(email)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 1)

    def test_wrong_purpose_challenge_rejected(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"m3-purpose-{secrets.token_hex(4)}@example.com"
        password = "m3-wrong-purpose-password"
        self._create_v1_user(email, password)
        login, _ = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        csrf = self._csrf()

        pw_chal = self.client.post(
            "/api/account/password/challenge",
            json={"email": email},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(pw_chal.status_code, 200, pw_chal.get_json())
        body = pw_chal.get_json()
        a_hex, m1 = srp_client_proof(
            email, password, body["srp_salt"], body["B"], body.get("srp_kdf_version"),
        )
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)
        up = self._upgrade(
            csrf,
            srp_salt=new_salt,
            srp_verifier=new_verifier,
            srp_kdf_version=2,
            A=a_hex,
            M1=m1,
        )
        self.assertEqual(up.status_code, 403, up.get_json())
        user = notes_db.get_user_by_email(email)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 1)

    def test_already_v2_rejected(self):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"m3-v2-{secrets.token_hex(4)}@example.com"
        password = "m3-already-v2-password"
        salt, verifier = self._srp_pair(email, password, kdf_version=2)
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
        csrf = self._csrf()
        chal = self._upgrade_challenge(csrf, email)
        self.assertEqual(chal.status_code, 400, chal.get_json())

        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)
        up = self._upgrade(
            csrf,
            srp_salt=new_salt,
            srp_verifier=new_verifier,
            srp_kdf_version=2,
            A="aa",
            M1="bb",
        )
        self.assertEqual(up.status_code, 400, up.get_json())
        self.assertEqual(up.get_json().get("error"), "already upgraded")

    def test_upgrade_requires_totp_then_succeeds(self):
        import db as notes_db
        import pyotp
        import totp as totp_mod
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"m3-2fa-{secrets.token_hex(4)}@example.com"
        password = "m3-totp-pending-password"
        uid, _, _ = self._create_v1_user(email, password)
        secret = totp_mod.new_secret()
        notes_db.connection().execute(
            "UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?",
            (secret, uid),
        )
        notes_db.connection().commit()

        login, _ = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertTrue(login.get_json().get("totp_required"))
        csrf = self._csrf()
        before = self._upgrade_challenge(csrf, email)
        self.assertEqual(before.status_code, 403, before.get_json())
        self.assertEqual(before.get_json().get("error"), "2FA required")
        self.assertEqual(notes_db.user_srp_kdf_version(notes_db.get_user_by_email(email)), 1)

        verified = self.client.post(
            "/api/totp/verify",
            json={"code": pyotp.TOTP(secret).now()},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())

        chal = self._upgrade_challenge(csrf, email)
        self.assertEqual(chal.status_code, 200, chal.get_json())
        body = chal.get_json()
        a_hex, m1 = srp_client_proof(
            email, password, body["srp_salt"], body["B"], body.get("srp_kdf_version"),
        )
        new_salt = new_srp_salt_hex()
        new_verifier = generate_verifier_hex(new_salt, email, password, kdf_version=2)
        up = self._upgrade(
            csrf,
            srp_salt=new_salt,
            srp_verifier=new_verifier,
            srp_kdf_version=2,
            A=a_hex,
            M1=m1,
        )
        self.assertEqual(up.status_code, 200, up.get_json())
        user = notes_db.get_user_by_email(email)
        self.assertEqual(notes_db.user_srp_kdf_version(user), 2)

    def test_fake_challenge_reports_signup_kdf_version(self):
        from srp_auth import SRP_KDF_V2

        unknown = f"nosuch-{secrets.token_hex(4)}@example.com"
        res = self.client.post("/api/auth/srp/challenge", json={"email": unknown})
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(int(res.get_json()["srp_kdf_version"]), SRP_KDF_V2)

    def test_client_upgrade_proves_current_password(self):
        src = (REPO / "app" / "static" / "js" / "srp-auth.js").read_text(encoding="utf-8")
        totp = (REPO / "app" / "static" / "js" / "totp-page.js").read_text(encoding="utf-8")
        gate = (REPO / "app" / "app.py").read_text(encoding="utf-8")
        exemption = gate[gate.index("if not skipped and auth.needs_totp()") : gate.index("return redirect(url_for(\"totp_page\"")]
        self.assertNotIn("/api/auth/srp/kdf-upgrade", exemption)
        self.assertIn("if (result.totp_required) return result;", src)
        self.assertIn("/api/auth/srp/kdf-upgrade/challenge", src)
        self.assertIn("A: creds.A", src)
        self.assertIn("M1: creds.M1", src)
        self.assertIn("client.step3(upgraded.M2)", src)
        self.assertIn("maybeUpgradeSrpKdf", totp)


if __name__ == "__main__":
    unittest.main()
