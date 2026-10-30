"""Round 82: Free plan, session soft-cap, Secure Send limit keys, grandfathering."""
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
ROOT = Path(__file__).resolve().parents[1]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


class Round82FreeTierUnitTests(unittest.TestCase):
    def test_plans_catalog_and_limits(self):
        import plans

        os.environ.pop("NOTES_DEFAULT_PLAN", None)
        self.assertEqual(plans.default_plan(), "free")
        self.assertEqual(plans.plan_storage_quota_bytes("free"), 50 * 1024 * 1024)
        self.assertEqual(plans.plan_storage_quota_bytes("basic"), 100 * 1024 * 1024)
        self.assertEqual(plans.plan_storage_quota_bytes("pro"), 5 * 1024 * 1024 * 1024)
        self.assertEqual(plans.plan_active_session_limit("free"), 3)
        self.assertEqual(plans.plan_active_session_limit("basic"), 10)
        self.assertIsNone(plans.plan_active_session_limit("pro"))
        self.assertEqual(plans.plan_secure_send_daily_limit("free"), 3)
        self.assertEqual(plans.plan_secure_send_daily_limit("basic"), 10)
        self.assertIsNone(plans.plan_secure_send_daily_limit("pro"))
        # Test hook only until Secure Send (#184) lands.
        self.assertFalse(plans.secure_send_over_daily_limit("free", 2))
        self.assertTrue(plans.secure_send_over_daily_limit("free", 3))
        self.assertFalse(plans.secure_send_over_daily_limit("pro", 999))
        self.assertTrue(plans.plan_has("free", "sync"))
        self.assertTrue(plans.plan_has("free", "attachments"))
        self.assertTrue(plans.plan_has("free", "import_export"))
        self.assertTrue(plans.plan_has("free", "document_ocr"))
        self.assertFalse(plans.plan_has("free", "passkeys"))
        self.assertFalse(plans.plan_has("free", "account_2fa"))
        self.assertFalse(plans.plan_has("free", "email_backup"))
        self.assertFalse(plans.plan_has("free", "pcloud_backup"))
        self.assertFalse(plans.plan_has("free", "reminders"))
        self.assertFalse(plans.plan_has("free", "vault_authenticator"))
        self.assertTrue(plans.plan_has("basic", "document_ocr"))
        self.assertFalse(plans.plan_has("basic", "passkeys"))
        self.assertTrue(plans.plan_has("pro", "passkeys"))
        self.assertTrue(plans.plan_has("pro", "vault_authenticator"))
        catalog = plans.account_plan_payload("free")["plan_catalog"]
        self.assertEqual(list(catalog.keys()), ["free", "basic", "pro"])
        self.assertEqual(catalog["free"]["storage_quota_mb"], 50)
        src = (APP_DIR / "plans.py").read_text(encoding="utf-8")
        self.assertIn("secure_send_over_daily_limit", src)
        self.assertIn("PLAN_SECURE_SEND_DAILY_LIMITS", src)

    def test_env_default_plan_override_and_invalid(self):
        import plans

        os.environ["NOTES_DEFAULT_PLAN"] = "pro"
        try:
            self.assertEqual(plans.default_plan(), "pro")
        finally:
            os.environ.pop("NOTES_DEFAULT_PLAN", None)
        os.environ["NOTES_DEFAULT_PLAN"] = "not-a-plan"
        try:
            self.assertEqual(plans.default_plan(), "free")
        finally:
            os.environ.pop("NOTES_DEFAULT_PLAN", None)

    def test_db_migration_does_not_rewrite_plans_to_free(self):
        db_src = (APP_DIR / "db.py").read_text(encoding="utf-8")
        # Grandfathering: adding the column still defaults existing rows to Pro.
        self.assertIn("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT '{PLAN_PRO}'", db_src)
        self.assertIn("UPDATE users SET plan = ?", db_src)
        self.assertNotIn("UPDATE users SET plan = 'free'", db_src)
        self.assertNotIn('UPDATE users SET plan = "free"', db_src)


class Round82FreeTierAppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round82"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "0"
        os.environ.pop("NOTES_DEFAULT_PLAN", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round82-secret", encoding="utf-8")

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
                "plans",
                "admin_api",
                "email_verify",
                "deeperguard_app",
            } or name.startswith("app."):
                sys.modules.pop(name, None)

        spec = importlib.util.spec_from_file_location(
            "deeperguard_app", APP_DIR / "app.py",
        )
        self.app_mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["deeperguard_app"] = self.app_mod
        spec.loader.exec_module(self.app_mod)
        self.app = self.app_mod.app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        import db as notes_db
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        self.notes_db = notes_db
        self.new_kdf_salt = new_kdf_salt
        self.generate_verifier_hex = generate_verifier_hex
        self.new_srp_salt_hex = new_srp_salt_hex

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop("NOTES_DEFAULT_PLAN", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)

    def _create_user(self, email: str, password: str, *, plan: str | None = None) -> int:
        salt = self.new_srp_salt_hex()
        verifier = self.generate_verifier_hex(salt, email, password, kdf_version=2)
        uid = self.notes_db.create_user_srp(
            email,
            self.new_kdf_salt(),
            salt,
            verifier,
            srp_kdf_version=2,
            plan=plan,
        )
        self.notes_db.mark_email_verified(uid)
        return uid

    def _srp_login(self, email: str, password: str, *, device_id: str = ""):
        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x, normalize_srp_kdf_version

        headers = {}
        if device_id:
            headers["X-Device-Id"] = device_id
        challenge = self.client.post(
            "/api/auth/srp/challenge", json={"email": email}, headers=headers
        )
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
        return self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
            headers=headers,
        )

    def test_new_registration_defaults_to_free_quota(self):
        from plans import plan_storage_quota_bytes

        uid = self._create_user("free-new@home.local", "free-secure-pass-ok")
        user = self.notes_db.get_user_by_id(uid)
        self.assertEqual(self.notes_db.user_plan(user), "free")
        self.assertEqual(int(user["storage_quota_bytes"]), plan_storage_quota_bytes("free"))

    def test_existing_pro_and_basic_unchanged(self):
        from plans import plan_has, plan_storage_quota_bytes

        pro_id = self._create_user("keep-pro@home.local", "pro-secure-pass-ok", plan="pro")
        basic_id = self._create_user("keep-basic@home.local", "basic-secure-pass-ok", plan="basic")
        pro = self.notes_db.get_user_by_id(pro_id)
        basic = self.notes_db.get_user_by_id(basic_id)
        self.assertEqual(self.notes_db.user_plan(pro), "pro")
        self.assertEqual(self.notes_db.user_plan(basic), "basic")
        self.assertEqual(int(pro["storage_quota_bytes"]), plan_storage_quota_bytes("pro"))
        self.assertEqual(int(basic["storage_quota_bytes"]), plan_storage_quota_bytes("basic"))
        self.assertTrue(plan_has("pro", "passkeys"))
        self.assertFalse(plan_has("basic", "passkeys"))
        self.assertFalse(plan_has("free", "passkeys"))

    def test_free_plan_blocks_pro_gates_allows_ocr_flag(self):
        self._create_user("gates@home.local", "gates-secure-pass-ok", plan="free")
        login = self._srp_login("gates@home.local", "gates-secure-pass-ok", device_id="gates-device-1")
        self.assertEqual(login.status_code, 200, login.get_json())
        csrf = login.get_json()["csrf"]
        headers = {"X-CSRF-Token": csrf, "X-Device-Id": "gates-device-1"}
        account = self.client.get("/api/account", headers=headers)
        self.assertEqual(account.status_code, 200)
        feats = account.get_json()["plan_features"]
        self.assertTrue(feats["document_ocr"])
        self.assertTrue(feats["sync"])
        self.assertFalse(feats["passkeys"])
        self.assertFalse(feats["email_backup"])
        blocked = self.client.post("/api/auth/webauthn/register/options", headers=headers)
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(blocked.get_json()["code"], "plan_required")

    def test_over_quota_does_not_delete(self):
        uid = self._create_user("quota@home.local", "quota-secure-pass-ok", plan="free")
        self.notes_db.update_user_storage_quota(uid, 64)
        login = self._srp_login("quota@home.local", "quota-secure-pass-ok", device_id="quota-dev")
        self.assertEqual(login.status_code, 200)
        csrf = login.get_json()["csrf"]
        headers = {"X-CSRF-Token": csrf, "X-Device-Id": "quota-dev"}
        seed = self.client.post(
            "/api/sync/items",
            headers=headers,
            json={
                "items": [{
                    "item_uuid": "r82-seed",
                    "content_version": 1,
                    "ciphertext": "ok",
                    "content_hash": "seed-hash",
                    "deleted": False,
                    "updated_at": 1.0,
                }],
                "partial_ok": True,
            },
        )
        self.assertEqual(seed.status_code, 200, seed.get_json())
        before = self.notes_db.user_vault_stats(uid)["item_count"]
        big = self.client.post(
            "/api/sync/items",
            headers=headers,
            json={
                "items": [{
                    "item_uuid": "r82-big",
                    "content_version": 1,
                    "ciphertext": "x" * 128,
                    "content_hash": "big-hash",
                    "deleted": False,
                    "updated_at": 2.0,
                }],
                "partial_ok": True,
            },
        )
        body = big.get_json()
        self.assertEqual(big.status_code, 413)
        self.assertEqual(body["results"][0]["status"], "quota_exceeded")
        after = self.notes_db.user_vault_stats(uid)["item_count"]
        self.assertEqual(after, before)
        kept = self.notes_db.list_items_by_uuid(uid, ["r82-seed", "r82-big"])
        uuids = {str(row.get("item_uuid") or "") for row in kept}
        self.assertIn("r82-seed", uuids)
        self.assertNotIn("r82-big", uuids)

    def test_session_cap_blocks_new_device_without_auto_revoke(self):
        email = "cap@home.local"
        password = "cap-secure-pass-ok"
        uid = self._create_user(email, password, plan="free")
        for i in range(3):
            self.notes_db.create_user_session(
                uid,
                device_label=f"Device {i}",
                user_agent=f"UA/{i}",
                ip="127.0.0.1",
                ip_location="Local network",
                device_id=f"cap-device-{i}",
                login=True,
            )
        live_before = self.notes_db.list_user_sessions(
            uid, active_since=time.time() - 86400
        )
        self.assertEqual(len(live_before), 3)
        blocked = self._srp_login(email, password, device_id="cap-device-new")
        self.assertEqual(blocked.status_code, 403)
        body = blocked.get_json()
        self.assertEqual(body["code"], "session_cap")
        self.assertEqual(body["limit"], 3)
        self.assertEqual(len(body["sessions"]), 3)
        self.assertTrue(body.get("revoke_token"))
        for row in body["sessions"]:
            self.assertNotIn("ip", row)
            self.assertTrue(row.get("ip_location"))
        live_after = self.notes_db.list_user_sessions(
            uid, active_since=time.time() - 86400
        )
        self.assertEqual(len(live_after), 3)
        for row in live_after:
            self.assertEqual(float(row["revoked_at"] or 0), 0)

        # Reuse of an existing device id must still sign in (does not consume a new slot).
        reuse = self._srp_login(email, password, device_id="cap-device-0")
        self.assertEqual(reuse.status_code, 200, reuse.get_json())
        self.client.post("/api/auth/logout")

        # Still at the soft cap — a fourth distinct device stays blocked.
        # Re-seed three live sessions in case logout pruned the reused row.
        live = self.notes_db.list_user_sessions(uid, active_since=time.time() - 86400)
        if len(live) < 3:
            for i in range(3 - len(live)):
                self.notes_db.create_user_session(
                    uid,
                    device_label=f"Extra {i}",
                    user_agent=f"ExtraUA/{i}",
                    ip="127.0.0.1",
                    ip_location="Local network",
                    device_id=f"cap-extra-{i}",
                    login=True,
                )
        blocked2 = self._srp_login(email, password, device_id="cap-device-new")
        self.assertEqual(blocked2.status_code, 403, blocked2.get_json())
        revoke_token = blocked2.get_json()["revoke_token"]
        victim = blocked2.get_json()["sessions"][0]["id"]
        revoked = self.client.post(
            "/api/auth/session-cap/revoke",
            json={"session_id": victim, "revoke_token": revoke_token},
        )
        self.assertEqual(revoked.status_code, 200, revoked.get_json())
        self.assertTrue(revoked.get_json()["can_sign_in"])
        ok = self._srp_login(email, password, device_id="cap-device-new")
        self.assertEqual(ok.status_code, 200, ok.get_json())

    def test_basic_session_cap_is_ten_pro_unlimited(self):
        from plans import plan_active_session_limit

        self.assertEqual(plan_active_session_limit("basic"), 10)
        self.assertIsNone(plan_active_session_limit("pro"))
        uid = self._create_user("pro-cap@home.local", "pro-cap-secure-pass", plan="pro")
        for i in range(12):
            self.notes_db.create_user_session(
                uid,
                device_label=f"P{i}",
                user_agent=f"UA/{i}",
                ip="127.0.0.1",
                ip_location="Local network",
                device_id=f"pro-device-{i}",
                login=True,
            )
        ok = self._srp_login("pro-cap@home.local", "pro-cap-secure-pass", device_id="pro-device-new")
        self.assertEqual(ok.status_code, 200, ok.get_json())

    def test_totp_user_at_cap_gets_no_sessions_until_totp(self):
        """TOTP-required accounts must not see sessions/IPs/revoke from password proof alone."""
        import pyotp
        import totp as totp_mod

        email = "cap-totp@home.local"
        password = "cap-totp-secure-pass"
        uid = self._create_user(email, password, plan="free")
        secret = totp_mod.new_secret()
        self.notes_db.update_user_totp(uid, secret, enabled=True)
        for i in range(3):
            self.notes_db.create_user_session(
                uid,
                device_label=f"TDevice {i}",
                user_agent=f"TUA/{i}",
                ip=f"203.0.113.{10 + i}",
                ip_location="Vienna, AT",
                device_id=f"totp-cap-{i}",
                login=True,
            )
        blocked = self._srp_login(email, password, device_id="totp-cap-new")
        self.assertEqual(blocked.status_code, 403, blocked.get_json())
        body = blocked.get_json()
        self.assertEqual(body["code"], "session_cap")
        self.assertTrue(body.get("totp_required"))
        self.assertNotIn("sessions", body)
        self.assertFalse(body.get("sessions"))
        self.assertNotIn("revoke_token", body)
        self.assertFalse(body.get("revoke_token"))
        dumped = str(body)
        self.assertNotIn("203.0.113.", dumped)
        self.assertNotIn("Vienna", dumped)

        # Revoke must fail — no token was issued before TOTP.
        denied = self.client.post(
            "/api/auth/session-cap/revoke",
            json={"session_id": 1, "revoke_token": "forged"},
        )
        self.assertIn(denied.status_code, {401, 429})

        # Complete TOTP — then the session list + revoke token are available.
        csrf = None
        with self.client.session_transaction() as sess:
            csrf = sess.get("csrf")
            self.assertTrue(sess.get("session_cap_pending"))
            self.assertFalse(sess.get("totp_ok"))
            self.assertFalse(sess.get("sid"))
        code = pyotp.TOTP(secret).now()
        verified = self.client.post(
            "/api/totp/verify",
            headers={"X-CSRF-Token": csrf},
            json={"code": code},
        )
        self.assertEqual(verified.status_code, 403, verified.get_json())
        after = verified.get_json()
        self.assertEqual(after["code"], "session_cap")
        self.assertEqual(len(after["sessions"]), 3)
        self.assertTrue(after.get("revoke_token"))
        for row in after["sessions"]:
            self.assertNotIn("ip", row)
            self.assertEqual(row.get("ip_location"), "Vienna, AT")

        victim = after["sessions"][0]["id"]
        revoked = self.client.post(
            "/api/auth/session-cap/revoke",
            json={"session_id": victim, "revoke_token": after["revoke_token"]},
        )
        self.assertEqual(revoked.status_code, 200, revoked.get_json())
        self.assertTrue(revoked.get_json()["can_sign_in"])

    def test_session_cap_revoke_token_bound_to_uid(self):
        """A revoke token for user A cannot revoke user B's session."""
        email_a = "cap-a@home.local"
        email_b = "cap-b@home.local"
        password = "cap-cross-secure-pass"
        uid_a = self._create_user(email_a, password, plan="free")
        uid_b = self._create_user(email_b, password, plan="free")
        for i in range(3):
            self.notes_db.create_user_session(
                uid_a,
                device_label=f"A{i}",
                user_agent=f"AUA/{i}",
                ip="127.0.0.1",
                ip_location="Local network",
                device_id=f"a-dev-{i}",
                login=True,
            )
        for i in range(3):
            self.notes_db.create_user_session(
                uid_b,
                device_label=f"B{i}",
                user_agent=f"BUA/{i}",
                ip="127.0.0.1",
                ip_location="Local network",
                device_id=f"b-dev-{i}",
                login=True,
            )
        b_rows = self.notes_db.list_user_sessions(uid_b, active_since=time.time() - 86400)
        self.assertEqual(len(b_rows), 3)
        b_victim = int(b_rows[0]["id"])

        blocked = self._srp_login(email_a, password, device_id="a-new")
        self.assertEqual(blocked.status_code, 403, blocked.get_json())
        token_a = blocked.get_json()["revoke_token"]
        cross = self.client.post(
            "/api/auth/session-cap/revoke",
            json={"session_id": b_victim, "revoke_token": token_a},
        )
        self.assertEqual(cross.status_code, 404, cross.get_json())
        still = self.notes_db.get_user_session(b_victim, uid_b)
        self.assertIsNotNone(still)
        self.assertEqual(float(still["revoked_at"] or 0), 0)

    def test_totp_enable_relogin_ignores_session_cap(self):
        """Enabling TOTP must re-establish the current device even if the soft-cap is full."""
        from unittest.mock import patch

        import auth as auth_mod

        email = "totp-relogin@home.local"
        password = "totp-relogin-secure-pass"
        uid = self._create_user(email, password, plan="pro")
        login = self._srp_login(email, password, device_id="relogin-dev")
        self.assertEqual(login.status_code, 200, login.get_json())
        csrf = login.get_json()["csrf"]
        headers = {"X-CSRF-Token": csrf, "X-Device-Id": "relogin-dev"}
        secret = "BASE32SECRETBASE32SECRETBASE"
        self.notes_db.update_user_totp(uid, secret, enabled=False)

        def _cap(*_a, **_k):
            raise auth_mod.SessionCapExceeded(
                {
                    "error": "cap",
                    "code": "session_cap",
                    "limit": 3,
                    "plan": "free",
                    "sessions": [],
                },
                user_id=uid,
            )

        with patch("deeperguard_app.totp_mod.verify_and_step", return_value=(True, 1)), patch(
            "auth._assert_session_slot_available", side_effect=_cap
        ):
            enabled = self.client.post(
                "/api/totp/enable",
                headers=headers,
                json={"code": "123456"},
            )
        self.assertEqual(enabled.status_code, 200, enabled.get_json())
        self.assertTrue(enabled.get_json().get("ok"))
        user = self.notes_db.get_user_by_id(uid)
        self.assertTrue(user["totp_enabled"])
        # Contract: enable/disable pass check_cap=False so a full soft-cap cannot
        # block an already-signed-in user refreshing their device session.
        src = (ROOT / "app/app.py").read_text(encoding="utf-8")
        self.assertIn("_login_user(uid, totp_ok=True, check_cap=False)", src)

    def test_admin_accepts_free_plan(self):
        admin_id = self._create_user("admin82@home.local", "admin-secure-pass-ok", plan="pro")
        member_id = self._create_user("member82@home.local", "member-secure-pass-ok", plan="pro")
        self.notes_db.update_user_admin_flag(admin_id, True)
        login = self._srp_login("admin82@home.local", "admin-secure-pass-ok", device_id="admin-dev")
        self.assertEqual(login.status_code, 200, login.get_json())
        csrf = login.get_json()["csrf"]
        # Confirm session sees admin before the plan patch (guards stale admin_api imports).
        account = self.client.get(
            "/api/account",
            headers={"X-CSRF-Token": csrf, "X-Device-Id": "admin-dev"},
        )
        self.assertEqual(account.status_code, 200, account.get_json())
        self.assertTrue(account.get_json().get("is_admin"), account.get_json())
        patch = self.client.patch(
            f"/api/admin/users/{member_id}",
            headers={"X-CSRF-Token": csrf, "X-Device-Id": "admin-dev"},
            json={"plan": "free"},
        )
        self.assertEqual(patch.status_code, 200, patch.get_json())
        self.assertEqual(patch.get_json()["user"]["plan"], "free")
        member = self.notes_db.get_user_by_id(member_id)
        self.assertEqual(self.notes_db.user_plan(member), "free")

    def test_copy_surfaces_free_basic_pro(self):
        marketing = (ROOT / "app/templates/marketing.html").read_text(encoding="utf-8")
        app_html = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
        admin_js = (ROOT / "app/static/js/admin.js").read_text(encoding="utf-8")
        app_js = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
        auth_pages = (ROOT / "app/static/js/auth-pages.js").read_text(encoding="utf-8")
        login_html = (ROOT / "app/templates/login.html").read_text(encoding="utf-8")
        css = (ROOT / "app/static/css/marketing.css").read_text(encoding="utf-8")
        self.assertIn("{{ free.label }}", marketing)
        self.assertNotIn("Public beta · Free access", marketing)
        self.assertIn("Start on Free", marketing)
        self.assertIn("Secure Send (encrypted share-by-link)", marketing)
        self.assertNotIn("Billing not active yet", marketing)
        self.assertNotIn("when billing launches", marketing)
        self.assertNotIn("public beta", marketing.lower())
        self.assertNotIn("Every new account gets full Pro free during the public beta", marketing)
        self.assertIn("Signed-in devices", marketing)
        self.assertIn("How many devices can I stay signed in on?", marketing)
        self.assertIn("Ask AI with Ollama Cloud", marketing)
        self.assertNotIn("document OCR, and the vault authenticator", marketing)
        self.assertIn('content: "Free"', css)
        self.assertIn('content: "Basic"', css)
        self.assertIn('content: "Pro"', css)
        self.assertIn(".mk-distinction-grid > *", css)
        self.assertIn("Compare Free, Basic &amp; Pro", app_html)
        self.assertIn('value="free"', admin_js)
        self.assertIn("plan-badge-free", app_js)
        self.assertIn("Free forever", app_js)
        self.assertIn("session_cap", auth_pages)
        self.assertIn("Sign out", auth_pages)
        self.assertIn("Couldn't sign out that device", auth_pages)
        self.assertIn("notes_session_cap_totp", auth_pages)
        self.assertIn("Signing out a device ends its session there", login_html)
        freelancers = (ROOT / "app/templates/for-freelancers.html").read_text(encoding="utf-8")
        compare_sn = (ROOT / "app/templates/compare-standard-notes.html").read_text(encoding="utf-8")
        self.assertNotIn("with OCR, backups, passkeys", freelancers)
        self.assertIn("WASM OCR in the browser", compare_sn)
        self.assertNotIn("WASM OCR in the browser <span class=\"mk-pro-tag\">Pro</span>", compare_sn)

    def test_session_cap_message_and_free_forever_billing_note(self):
        import auth as auth_mod
        import plans

        msg = auth_mod.session_cap_message(limit=3, plan="free", totp_required=False)
        self.assertIn("Your Free plan allows 3 signed-in devices, and all 3 are in use", msg)
        self.assertIn("Sign out one below", msg)
        self.assertIn("or upgrade to Basic (10 devices) or Pro (unlimited)", msg)
        basic_msg = auth_mod.session_cap_message(limit=10, plan="basic", totp_required=False)
        self.assertIn("or upgrade to Pro (unlimited)", basic_msg)
        self.assertNotIn("Basic (", basic_msg)
        pro_msg = auth_mod.session_cap_message(limit=3, plan="pro", totp_required=False)
        self.assertIn("Sign out one below, then sign in again.", pro_msg)
        self.assertNotIn("upgrade", pro_msg)
        totp_msg = auth_mod.session_cap_message(limit=3, plan="free", totp_required=True)
        self.assertIn("Enter the code from your authenticator app", totp_msg)
        self.assertNotIn("2FA code", totp_msg)
        totp_js = (ROOT / "app/static/js/totp-page.js").read_text(encoding="utf-8")
        self.assertIn("You're signed in on the most devices your plan allows", totp_js)
        self.assertIn("sessionStorage.removeItem('notes_session_cap_totp')", totp_js)
        auth_pages = (ROOT / "app/static/js/auth-pages.js").read_text(encoding="utf-8")
        self.assertGreaterEqual(auth_pages.count("removeItem('notes_session_cap_totp')"), 2)
        totp_html = (ROOT / "app/templates/totp.html").read_text(encoding="utf-8")
        self.assertIn('class="hint session-cap-panel"', totp_html)
        free_note = plans.plan_pricing_payload("free")["billing_note"]
        pro_note = plans.plan_pricing_payload("pro")["billing_note"]
        self.assertEqual(free_note, "Free forever")
        self.assertIn("€6.99/mo", pro_note)
        self.assertNotIn("billing launches", pro_note)


if __name__ == "__main__":
    unittest.main()
