"""Round 51: upgrade → logout → login must not poison unlock; vault rows untouched."""
from __future__ import annotations

import importlib
import os
import secrets
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


class Round51PostLoginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round51"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round51-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app", "auth", "db", "config", "passwords", "totp", "srp_auth",
                "webauthn_helper", "auth_rate_limit", "email_verify",
                "verification_send_limit", "plans",
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
            email, new_kdf_salt(), salt, verifier,
            srp_kdf_version=1, storage_quota_bytes=10 * 1024 * 1024,
        )
        notes_db.connection().execute(
            "UPDATE users SET email_verified = 1, storage_quota_bytes = ?, vault_kdf_version = 1 WHERE id = ?",
            (100 * 1024 * 1024, uid),
        )
        notes_db.connection().commit()
        return uid

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

    def test_upgrade_logout_login_preserves_items_and_password_changed_at(self):
        import db as notes_db
        from srp_auth import generate_verifier_hex, new_srp_salt_hex
        from vault_crypto import encrypt_object

        email = f"r51-{secrets.token_hex(4)}@example.com"
        password = "r51-vault-and-login-password"
        uid = self._create_v1_user(email, password)
        user = notes_db.get_user_by_email(email)
        vault_salt = str(user["kdf_salt"])

        # Seed one encrypted note (v1 vault KDF) — must survive upgrade/login.
        blob = encrypt_object(password, vault_salt, 1, {"type": "note", "title": "keep-me", "content": "x"})
        import json
        cipher = json.dumps(blob)
        notes_db.connection().execute(
            """
            INSERT INTO items (user_id, item_uuid, content_version, ciphertext, content_hash,
                               deleted, updated_at, synced_at)
            VALUES (?, ?, 1, ?, 'hash-r51', 0, 1000, 1000)
            """,
            (uid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cipher),
        )
        notes_db.connection().commit()
        before_hash = notes_db.connection().execute(
            "SELECT content_hash, ciphertext FROM items WHERE user_id = ?", (uid,)
        ).fetchone()

        # Simulate Round 49 false bump (old touch_password_changed=True).
        bump_salt = new_srp_salt_hex()
        bump_ver = generate_verifier_hex(bump_salt, email, password, kdf_version=2)
        notes_db.update_user_srp_verifier(
            uid, bump_salt, bump_ver, srp_kdf_version=2, touch_password_changed=True,
        )
        bumped = notes_db.user_password_changed_at(notes_db.get_user_by_email(email))
        self.assertGreater(bumped, 0)

        # Stale vault_kdf_version=2 metadata (production +r19 shape) without re-encrypting.
        notes_db.connection().execute(
            "UPDATE users SET vault_kdf_version = 2 WHERE id = ?", (uid,)
        )
        notes_db.connection().commit()

        self.client.post("/api/auth/logout")
        login, chal = self._login(email, password)
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertEqual(int(chal["srp_kdf_version"]), 2)
        self.assertFalse(login.get_json().get("srp_kdf_upgrade"))
        # Login payload carries the bumped timestamp so the client can ack it.
        self.assertGreaterEqual(float(login.get_json().get("password_changed_at") or 0), bumped - 0.001)
        self.assertEqual(int(login.get_json().get("vault_kdf_version") or 0), 2)

        account = self.client.get("/api/account")
        self.assertEqual(account.status_code, 200)
        self.assertEqual(int(account.get_json().get("vault_kdf_version") or 0), 2)

        after = notes_db.connection().execute(
            "SELECT content_hash, ciphertext FROM items WHERE user_id = ?", (uid,)
        ).fetchone()
        self.assertEqual(after["content_hash"], before_hash["content_hash"])
        self.assertEqual(after["ciphertext"], before_hash["ciphertext"])

        # Second login still works; current upgrade path must not re-bump.
        changed = notes_db.user_password_changed_at(notes_db.get_user_by_email(email))
        self.client.post("/api/auth/logout")
        login2, _ = self._login(email, password)
        self.assertEqual(login2.status_code, 200)
        self.assertEqual(
            notes_db.user_password_changed_at(notes_db.get_user_by_email(email)),
            changed,
        )


if __name__ == "__main__":
    unittest.main()
