"""Round 60: client integrity — manifest, SRI, health hash, hashed static."""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class Round60ClientIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round60"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["SOURCE_DATE_EPOCH"] = "0"
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        os.environ.pop("NOTES_CLIENT_MANIFEST", None)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round60-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app", "config", "auth", "db", "srp_auth", "auth_rate_limit",
                "client_assets", "server_info_cache",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        # Ensure a fresh manifest from current sources.
        build = subprocess.run(
            [sys.executable, str(REPO / "scripts" / "build-client-manifest.py")],
            cwd=str(REPO),
            env={**os.environ, "SOURCE_DATE_EPOCH": "0"},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(build.returncode, 0, build.stderr)
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

    def test_repro_script(self):
        proc = subprocess.run(
            [sys.executable, str(REPO / "scripts" / "build-client-manifest.py"), "--check-repro"],
            cwd=str(REPO),
            env={**os.environ, "SOURCE_DATE_EPOCH": "0"},
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("repro check ok", proc.stdout)

    def test_health_exposes_client_hash(self):
        import client_assets

        client_assets.reload_manifest()
        expected = client_assets.client_hash()
        self.assertEqual(len(expected), 64)
        resp = self.client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data.get("build"), "round60")
        self.assertEqual(data.get("client_hash"), expected)

    def test_app_shell_sri_and_meta(self):
        import client_assets

        client_assets.reload_manifest()
        expected = client_assets.client_hash()
        app_url = client_assets.asset_url("js/app.js")
        app_sri = client_assets.asset_sri("js/app.js")
        resp = self.client.get("/app")
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn(f'content="{expected}"', html)
        self.assertIn(f'name="notes-client-hash"', html)
        self.assertIn(f'src="{app_url}"', html)
        self.assertIn(f'integrity="{app_sri}"', html)
        self.assertIn("crossorigin=\"anonymous\"", html)
        self.assertIn('id="settings-about"', html)
        self.assertIn('id="about-client-hash"', html)
        # Hashed filename, not legacy ?v= for app.js
        self.assertNotIn("/static/js/app.js?v=", html)

    def test_hashed_static_serves_bytes(self):
        import client_assets

        client_assets.reload_manifest()
        url = client_assets.asset_url("js/crypto.js")
        raw = (REPO / "app" / "static" / "js" / "crypto.js").read_bytes()
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data, raw)
        # Immutable cache for hashed names
        self.assertIn("immutable", (resp.headers.get("Cache-Control") or "").lower())

    def test_bad_hash_not_resolved(self):
        resp = self.client.get("/static/js/app.0000000000000000.js")
        self.assertIn(resp.status_code, {404, 400})

    def test_verify_page_has_code_check_steps(self):
        resp = self.client.get("/verify")
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn("cosign verify-blob", html)
        self.assertIn("build-client-manifest.py", html)
        self.assertIn("manifest_sha256", html)
        self.assertNotIn("Placeholder for Round 60", html)

    def test_sw_js_byte_stable_no_build_embed(self):
        resp = self.client.get("/sw.js")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_data(as_text=True)
        self.assertIn("isVersioned", body)
        self.assertIn("[a-f0-9]{16}", body)
        self.assertNotIn("round60", body)
        cc = resp.headers.get("Cache-Control") or ""
        self.assertIn("must-revalidate", cc.lower())

    def test_manifest_sha_matches_file(self):
        manifest = json.loads((REPO / "app" / "static" / "client-manifest.json").read_text(encoding="utf-8"))
        lines = [f"{k}:{manifest['assets'][k]['sha256']}" for k in sorted(manifest["assets"])]
        digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
        self.assertEqual(digest, manifest["manifest_sha256"])


if __name__ == "__main__":
    unittest.main()
