"""'Recovery key used' notice on every other device, dismissible per device (task 341)."""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import test_round63_security as r63  # noqa: E402
import test_vault_recovery_reset as reset  # noqa: E402

LIST = "/api/account/vault-recovery-notices"
DEVICE_A = "a" * 32
DEVICE_B = "d" * 32
DEVICE_C = "c" * 32


class VaultRecoveryNoticeTests(unittest.TestCase):
    tearDown = r63.Round63SecurityTests.tearDown
    _csrf = r63.Round63SecurityTests._csrf
    _srp_pair = r63.Round63SecurityTests._srp_pair
    _create_srp_user = r63.Round63SecurityTests._create_srp_user
    _login = r63.Round63SecurityTests._login
    _signed_in = reset.wraps.VaultRecoveryWrapTests._signed_in
    _token = reset.wraps.VaultRecoveryWrapTests._token
    _put = reset.wraps.VaultRecoveryWrapTests._put
    _status = reset.wraps.VaultRecoveryWrapTests._status
    _mail = reset.VaultRecoveryResetTests._mail
    _enrolled = reset.VaultRecoveryResetTests._enrolled
    _commit_body = reset.VaultRecoveryResetTests._commit_body
    _commit = reset.VaultRecoveryResetTests._commit

    def setUp(self):
        r63.Round63SecurityTests.setUp(self)
        self.mail = self._mail()
        self.client.environ_base["HTTP_X_DEVICE_ID"] = DEVICE_A

    def _device(self, device_id, email, password):
        """A fresh browser (own cookies) with a stable device id, signed in."""
        client = self.app_mod.app.test_client()
        client.environ_base["HTTP_X_DEVICE_ID"] = device_id
        client.environ_base["HTTP_USER_AGENT"] = "Mozilla/5.0 (X11; Linux) Firefox/130.0"
        main, self.client = self.client, client
        try:
            self.assertEqual(self._login(email, password).status_code, 200)
            return client, self._csrf()
        finally:
            self.client = main

    def _notices(self, client):
        resp = client.get(LIST)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()["notices"]

    def test_device_b_sees_the_notice_after_signing_in_again_and_can_dismiss_it(self):
        uid, email, password, csrf_a, proof, key_id = self._enrolled()
        device_b, _ = self._device(DEVICE_B, email, password)
        self.assertEqual(self._notices(device_b), [])

        started = time.time()
        new_password = "brand-new-password-1"
        resp = self._commit(csrf_a, self._commit_body(proof, email, new_password, key_id))
        self.assertEqual(resp.status_code, 200, resp.get_json())

        # B was signed out by the recovery; after signing in again it shows the notice.
        self.assertEqual(device_b.get(LIST).status_code, 401)
        device_b, csrf_b = self._device(DEVICE_B, email, new_password)
        notices = self._notices(device_b)
        self.assertEqual([n["kind"] for n in notices], ["recovery_key_used"])
        self.assertGreaterEqual(notices[0]["created_at"], started - 1)
        self.assertLessEqual(notices[0]["created_at"], time.time() + 1)

        # Dismissing is per device: B is clean (also after yet another sign-in), C still sees it.
        notice_id = notices[0]["id"]
        dismiss = f"{LIST}/{notice_id}/dismiss"
        self.assertEqual(device_b.post(dismiss).status_code, 400)  # CSRF required
        self.assertEqual(self._notices(device_b), [notices[0]])
        self.assertEqual(device_b.post(dismiss, headers={"X-CSRF-Token": csrf_b}).status_code, 200)
        self.assertEqual(device_b.post(dismiss, headers={"X-CSRF-Token": csrf_b}).status_code, 200)
        self.assertEqual(self._notices(device_b), [])
        device_b_again, _ = self._device(DEVICE_B, email, new_password)
        self.assertEqual(self._notices(device_b_again), [])
        device_c, _ = self._device(DEVICE_C, email, new_password)
        self.assertEqual([n["id"] for n in self._notices(device_c)], [notice_id])

    def test_the_device_that_used_the_key_gets_no_notice_about_itself(self):
        _, email, _, csrf_a, proof, key_id = self._enrolled()
        resp = self._commit(csrf_a, self._commit_body(proof, email, "brand-new-password-1", key_id))
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(self._notices(self.client), [])

    def test_old_events_expire_and_other_accounts_events_cannot_be_dismissed(self):
        import db as notes_db

        uid, email, password, csrf_a, proof, key_id = self._enrolled()
        self.assertEqual(
            self._commit(csrf_a, self._commit_body(proof, email, "brand-new-password-1", key_id)).status_code, 200,
        )
        event_id = notes_db.connection().execute("SELECT id FROM vault_recovery_events").fetchone()[0]
        device_b, csrf_b = self._device(DEVICE_B, email, "brand-new-password-1")
        self.assertEqual(len(self._notices(device_b)), 1)
        with notes_db.tx() as conn:
            conn.execute(
                "UPDATE vault_recovery_events SET created_at = ? WHERE id = ?",
                (time.time() - 31 * 86400, event_id),
            )
        self.assertEqual(self._notices(device_b), [])

        other_email = "other-account@example.com"
        self._create_srp_user(other_email, "other-account-password")
        other, other_csrf = self._device(DEVICE_C, other_email, "other-account-password")
        resp = other.post(f"{LIST}/{event_id}/dismiss", headers={"X-CSRF-Token": other_csrf})
        self.assertEqual(resp.status_code, 404)

    def test_signed_out_requests_are_refused(self):
        anonymous = self.app_mod.app.test_client()
        self.assertEqual(anonymous.get(LIST).status_code, 401)


if __name__ == "__main__":
    unittest.main()
