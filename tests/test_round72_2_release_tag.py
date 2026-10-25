"""Round 72.2: RELEASE_TAG drives notes-release-tag meta; deploy/tag fail closed."""
from __future__ import annotations

import importlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class Round72_2ReleaseTagTests(unittest.TestCase):
    def test_repo_release_tag_is_current(self):
        tag = (REPO / "RELEASE_TAG").read_text(encoding="utf-8").strip()
        self.assertEqual(tag, "v0.65.12")

    def test_check_release_tag_script(self):
        script = REPO / "scripts" / "check-release-tag.sh"
        self.assertTrue(script.is_file())
        ok = subprocess.run(
            ["bash", str(script), "--expect", "v0.65.12"],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(ok.returncode, 0, ok.stderr or ok.stdout)
        bad = subprocess.run(
            ["bash", str(script), "--expect", "v9.9.9"],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("expected 'v9.9.9'", bad.stderr)

    def test_deploy_script_requires_release_tag(self):
        deploy = (REPO / "deploy" / "deploy-deeperguard.sh").read_text(encoding="utf-8")
        self.assertIn("NOTES_RELEASE_TAG", deploy)
        self.assertIn("check-release-tag.sh", deploy)
        self.assertIn('printf \'%s\\n\' "${release_tag}" > RELEASE_TAG', deploy)
        self.assertIn("manifest_sha256", deploy)
        # Always ship RELEASE_TAG (no longer optional).
        self.assertIn("TAR_PATHS=(app deploy tests scripts", deploy)
        self.assertIn("RELEASE_TAG)", deploy)

    def test_release_workflow_checks_tag(self):
        # deploy/github-workflows is the source of truth until a workflow-scoped
        # token can sync .github/workflows/release-client.yml.
        wf = (REPO / "deploy" / "github-workflows" / "release-client.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("RELEASE_TAG must match git tag", wf)
        self.assertIn("check-release-tag.sh", wf)
        self.assertIn("GITHUB_REF_NAME", wf)

    def test_client_assets_reads_release_tag_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "RELEASE_TAG").write_text("v0.64.5\n", encoding="utf-8")
            os.environ["NOTES_ROOT"] = str(root)
            os.environ.pop("NOTES_RELEASE_TAG", None)
            for name in list(sys.modules):
                if name == "client_assets" or name.startswith("client_assets."):
                    sys.modules.pop(name, None)
            import client_assets

            importlib.reload(client_assets)
            self.assertEqual(client_assets.release_tag(), "v0.64.5")
            with mock.patch.dict(os.environ, {"NOTES_RELEASE_TAG": "v9.9.9"}):
                self.assertEqual(client_assets.release_tag(), "v9.9.9")


if __name__ == "__main__":
    unittest.main()
