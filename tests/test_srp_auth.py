"""Unit tests for SRP server session (step2 hardening)."""
import os
import sys
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


class SrpStep2SecurityTests(unittest.TestCase):
    def _server_session(self, email: str = "user@home.local", password: str = "secret-pass"):
        import secrets

        from srp_auth import G, K, N, SrpServerSession, _from_hex, _h, _to_hex, generate_verifier_hex, new_srp_salt_hex

        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password)
        sess = SrpServerSession()
        b_hex = sess.step1(email, salt, verifier)
        return sess, salt, verifier, b_hex, email, password, G, K, N, _from_hex, _h, _to_hex, secrets

    def _m1_for_s_zero(self, a_hex: str, b_hex: str, _h, _to_hex):
        return _h(a_hex + b_hex + _to_hex(0))

    def test_step2_rejects_degenerate_client_public_values(self):
        from srp_auth import N, _h, _to_hex

        sess, _salt, _verifier, b_hex, *_ = self._server_session()
        b_hex = b_hex.lower()
        degenerate_a = ("0", _to_hex(N), _to_hex(2 * N))
        for a_hex in degenerate_a:
            m1 = self._m1_for_s_zero(a_hex, b_hex, _h, _to_hex)
            with self.assertRaises(ValueError, msg=f"A={a_hex}"):
                sess.step2(a_hex, m1)
            self.assertEqual(sess.state, 1)
            self.assertEqual(sess.S, 0)

    def test_step2_rejects_malformed_client_public(self):
        sess, *_ = self._server_session()
        with self.assertRaises(ValueError):
            sess.step2("not-hex!", "abc123")
        self.assertEqual(sess.state, 1)

    def test_step2_rejects_missing_m1(self):
        sess, *_ = self._server_session()
        with self.assertRaises(ValueError):
            sess.step2("1a", "")
        self.assertEqual(sess.state, 1)

    def test_step2_accepts_valid_thinbus_proof(self):
        sess, salt, _verifier, b_hex, email, password, G, K, N, _from_hex, _h, _to_hex, secrets = self._server_session()
        b_hex = b_hex.lower()
        hash1 = _h(f"{email}:{password}")
        x_hash = _h(f"{salt}{hash1}".upper())
        x = int(x_hash, 16) % N
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a_bytes = secrets.token_bytes(byte_len)
            a = int.from_bytes(a_bytes, "big") % N
            if a != 0:
                break
        a_hex = _to_hex(pow(G, a, N))
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        v = pow(G, x, N)
        tmp = (v * K) % N
        S = pow((B - tmp + N) % N, (u * x + a) % N, N)
        m1 = _h(a_hex + b_hex + _to_hex(S))
        m2 = sess.step2(a_hex, m1)
        self.assertTrue(m2)
        self.assertEqual(sess.state, 2)

    def test_step2_m2_matches_thinbus_client_formula(self):
        from srp_auth import _h, _strip_hex, _to_hex

        sess, salt, _verifier, b_hex, email, password, G, K, N, _from_hex, _h, _to_hex, secrets = self._server_session()
        b_hex = b_hex.lower()
        hash1 = _h(f"{email}:{password}")
        x_hash = _h(f"{salt}{hash1}".upper())
        x = int(x_hash, 16) % N
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a_bytes = secrets.token_bytes(byte_len)
            a = int.from_bytes(a_bytes, "big") % N
            if a != 0:
                break
        a_hex = _to_hex(pow(G, a, N))
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        v = pow(G, x, N)
        tmp = (v * K) % N
        S = pow((B - tmp + N) % N, (u * x + a) % N, N)
        m1 = _h(a_hex + b_hex + _to_hex(S))
        m2_server = sess.step2(a_hex, m1)
        s_hex = _to_hex(S)
        m1_stripped = _strip_hex(m1)
        m2_client = _strip_hex(_h(a_hex + m1_stripped + s_hex))
        self.assertEqual(m2_server, m2_client)


class SrpM2EndToEndTests(unittest.TestCase):
    def test_browser_client_m2_matches_python_server(self):
        import shutil
        import subprocess
        from pathlib import Path

        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        script = Path(__file__).resolve().parent / "test_srp_m2_e2e.js"
        completed = subprocess.run(
            [node, str(script)],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "SRP_M2_ITERATIONS": "200"},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        self.assertIn("ok 200", completed.stdout)


if __name__ == "__main__":
    unittest.main()
