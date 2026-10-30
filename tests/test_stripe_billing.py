"""Stripe billing: webhooks, plan sync, checkout verify (mocked)."""
from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _stripe_env(root: Path) -> None:
    os.environ["STRIPE_SECRET_KEY"] = "sk_test_mock"
    os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test_secret"
    os.environ["STRIPE_PRICE_BASIC_MONTHLY"] = "price_basic_m"
    os.environ["STRIPE_PRICE_BASIC_YEARLY"] = "price_basic_y"
    os.environ["STRIPE_PRICE_PRO_MONTHLY"] = "price_pro_m"
    os.environ["STRIPE_PRICE_PRO_YEARLY"] = "price_pro_y"


def _sign_payload(payload: bytes, secret: str, ts: int | None = None) -> str:
    ts = int(ts or time.time())
    signed = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={signed}"


class StripeBillingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "stripe-billing-test"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DEFAULT_PLAN"] = "free"
        _stripe_env(root)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("stripe-test-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "plans",
                "stripe_billing",
                "passwords",
                "totp",
                "srp_auth",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        import db as notes_db

        notes_db.reset_connection()
        self.notes_db = notes_db
        import auth_rate_limit as arl

        arl._hits.clear()
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import stripe_billing as sb

        self.sb = importlib.reload(sb)

    def tearDown(self):
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
            "NOTES_DEFAULT_PLAN",
            "STRIPE_SECRET_KEY",
            "STRIPE_WEBHOOK_SECRET",
            "STRIPE_PRICE_BASIC_MONTHLY",
            "STRIPE_PRICE_BASIC_YEARLY",
            "STRIPE_PRICE_PRO_MONTHLY",
            "STRIPE_PRICE_PRO_YEARLY",
            "STRIPE_BILLING_ENABLED",
        ):
            os.environ.pop(key, None)

    def _register(self, email: str, password: str = "secure-pass-1234") -> int:
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        salt_hex = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt_hex, email, password)
        res = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email,
                "srp_salt": salt_hex,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
            },
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        user = self.notes_db.get_user_by_email(email)
        self.assertIsNotNone(user)
        self.notes_db.mark_email_verified(int(user["id"]))
        return int(user["id"])

    def _login(self, email: str, password: str = "secure-pass-1234") -> str:
        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x, normalize_srp_kdf_version
        import secrets

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
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )
        self.assertEqual(verify.status_code, 200, verify.get_json())
        return verify.get_json()["csrf"]

    def test_billing_active_when_configured(self):
        self.assertTrue(self.sb.billing_enabled())
        payload = self.sb.plan_pricing_with_billing("basic")
        self.assertTrue(payload["billing_active"])
        prev = os.environ.pop("STRIPE_SECRET_KEY", None)
        try:
            self.assertFalse(importlib.reload(self.sb).billing_enabled())
        finally:
            if prev:
                os.environ["STRIPE_SECRET_KEY"] = prev
            importlib.reload(self.sb)

    def test_webhook_checkout_completed_sets_pro_plan(self):
        uid = self._register("pay@home.local")
        self.notes_db.update_user_stripe_customer(uid, "cus_test_1")
        sub_obj = {
            "id": "sub_test_1",
            "customer": "cus_test_1",
            "status": "active",
            "cancel_at_period_end": False,
            "current_period_end": int(time.time()) + 86400,
            "metadata": {"user_id": str(uid), "plan": "pro"},
            "items": {"data": [{"price": {"id": "price_pro_m"}}]},
        }

        session_obj = mock.Mock(
            client_reference_id=str(uid),
            customer="cus_test_1",
            subscription="sub_test_1",
            metadata={"user_id": str(uid), "plan": "pro"},
        )
        event = mock.Mock(
            type="checkout.session.completed",
            data=mock.Mock(object=session_obj),
        )

        class FakeStripe:
            api_key = None

            class Subscription:
                @staticmethod
                def retrieve(sub_id):
                    assert sub_id == "sub_test_1"
                    return sub_obj

            class Webhook:
                @staticmethod
                def construct_event(raw, header, secret):
                    return event

            class error:
                SignatureVerificationError = Exception

        payload = b"{}"
        with mock.patch.object(self.sb, "_stripe_module", return_value=FakeStripe()):
            ok, detail = self.sb.handle_webhook_payload(payload, "sig")
        self.assertTrue(ok, detail)
        user = self.notes_db.get_user_by_id(uid)
        self.assertEqual(self.notes_db.user_plan(user), "pro")

    def test_subscription_deleted_sets_free(self):
        uid = self._register("down@home.local")
        self.notes_db.update_user_plan(uid, "basic")
        sub = {
            "id": "sub_x",
            "customer": "cus_x",
            "status": "canceled",
            "cancel_at_period_end": False,
            "current_period_end": int(time.time()),
            "metadata": {"user_id": str(uid)},
            "items": {"data": [{"price": {"id": "price_basic_m"}}]},
        }
        self.sb.apply_subscription_to_user(uid, sub)
        user = self.notes_db.get_user_by_id(uid)
        self.assertEqual(self.notes_db.user_plan(user), "free")

    def test_cancel_at_period_end_keeps_paid_plan(self):
        uid = self._register("cancel@home.local")
        self.notes_db.update_user_plan(uid, "pro")
        sub = {
            "id": "sub_y",
            "customer": "cus_y",
            "status": "active",
            "cancel_at_period_end": True,
            "current_period_end": int(time.time()) + 3600,
            "metadata": {"user_id": str(uid), "plan": "pro"},
            "items": {"data": [{"price": {"id": "price_pro_m"}}]},
        }
        self.sb.apply_subscription_to_user(uid, sub)
        user = self.notes_db.get_user_by_id(uid)
        self.assertEqual(self.notes_db.user_plan(user), "pro")
        self.assertEqual(int(user["stripe_cancel_at_period_end"]), 1)

    def test_checkout_api_requires_auth(self):
        res = self.client.post("/api/billing/checkout", json={"plan": "basic"})
        self.assertEqual(res.status_code, 401)

    def test_account_billing_inactive_without_stripe(self):
        prev = os.environ.pop("STRIPE_SECRET_KEY", None)
        try:
            sb = importlib.reload(self.sb)
            self.assertFalse(sb.billing_enabled())
            payload = sb.plan_pricing_with_billing("free")
            self.assertFalse(payload["billing_active"])
        finally:
            if prev:
                os.environ["STRIPE_SECRET_KEY"] = prev
            importlib.reload(self.sb)

    def test_marketing_copy_locked_strings(self):
        app_html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("Choose your plan", app_html)
        self.assertIn("Free stays free. Basic and Pro unlock more storage and Pro features.", app_html)
        self.assertIn("Continue to payment", app_html)
        self.assertIn("Manage billing", app_html)
        self.assertIn("You're on Basic. Plan limits update on this account now.", app_js)
        self.assertIn("Payment canceled. Your plan is unchanged.", app_js)
        self.assertIn("Payment didn't go through. Your plan is unchanged", app_js)
        self.assertIn("Your plan stays active until the end of the paid period, then returns to Free.", app_js)


if __name__ == "__main__":
    unittest.main()
