"""Required recovery key step after registration (docs/VAULT_RECOVERY.md 1.3, 5.1, test E1).

Real server and Chromium: a new account sees the recovery key, cannot continue
until it is confirmed, can print and download it, survives a failed save (the
step returns at the next unlock), and the server ends with exactly one wrapped
copy that the shown key opens and never the key or the vault key itself.
"""
from __future__ import annotations

import base64
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_recovery_key_step import DIALOG_OPEN, complete_recovery_key_step, read_shown_key  # noqa: E402
from e2e_share_target import UNLOCKED_JS, launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

RECOVERY_PUT = "/api/account/vault-keys/recovery"

PRINT_PROBE_JS = """() => {
  window.__printSeen = null;
  window.print = () => {
    const value = document.getElementById('recovery-key-value');
    const shell = document.getElementById('app-shell') || document.querySelector('.app-shell');
    const save = document.getElementById('recovery-key-save');
    window.__printSeen = {
      printing: document.body.classList.contains('recovery-key-printing'),
      valueShown: getComputedStyle(value).display !== 'none' && value.getClientRects().length > 0,
      value: value.textContent,
      shellShown: !!shell && shell.getClientRects().length > 0,
      saveShown: save.getClientRects().length > 0,
      meta: document.getElementById('recovery-key-print-date').innerText,
    };
  };
}"""


def _key_material(page, key_text: str) -> list[str]:
    """Hex, base64 and text forms of the recovery key and of the vault key."""
    raw = page.evaluate(
        """(text) => {
          const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
          const vk = NotesStore.vaultKeyCopy();
          return { rk: hex(NotesCrypto.decodeRecoveryKey(text)), vk: hex(vk.raw) };
        }""",
        key_text,
    )
    out = [key_text, key_text.replace("-", "")]
    for h in (raw["rk"], raw["vk"]):
        b = bytes.fromhex(h)
        out += [h, base64.b64encode(b).decode(), base64.urlsafe_b64encode(b).decode().rstrip("=")]
    return out


class RecoveryKeySetupE2E(unittest.TestCase):
    def test_new_account_must_store_recovery_key_before_continuing(self):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-recovery-key-"))
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        proc = start_server(root, port)
        db_file = root / "data" / "notes.db"

        def wrap_rows():
            con = sqlite3.connect(db_file)
            try:
                return con.execute(
                    "SELECT user_id, key_id, wrap_version, recovery_salt, wrap, proof_hash FROM vault_recovery_wraps"
                ).fetchall()
            finally:
                con.close()

        bodies: list[str] = []
        try:
            with sync_playwright() as p:
                browser = launch(p)
                ctx = browser.new_context(viewport={"width": 1280, "height": 860}, accept_downloads=True)
                page = ctx.new_page()
                page.on("request", lambda r: bodies.append(r.post_data or "") if r.method != "GET" else None)

                email = register(page, base, recovery_key_step=False)
                first_key, group = read_shown_key(page)
                self.assertRegex(first_key, r"^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{2}$")
                self.assertTrue(1 <= group <= 8)
                text = page.evaluate("() => document.documentElement.innerHTML").lower()
                self.assertIn("recovery key", text)
                self.assertNotIn("seed phrase", text)

                # Blocked: Escape does not close it, the app behind is covered,
                # and Continue refuses without the box and the right group.
                page.keyboard.press("Escape")
                self.assertTrue(page.is_visible(DIALOG_OPEN))
                covered = page.evaluate(
                    """() => {
                      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 3);
                      return !!el && !!el.closest('#recovery-key-dialog, #recovery-key-backdrop');
                    }"""
                )
                self.assertTrue(covered, "the app behind the recovery key step is reachable")
                page.click("#recovery-key-save")
                self.assertIn("Tick the box", page.text_content("#recovery-key-error"))
                page.check("#recovery-key-stored")
                wrong = "0000" if first_key.split("-")[group - 1] != "0000" else "1111"
                page.fill("#recovery-key-confirm-group", wrong)
                page.click("#recovery-key-save")
                self.assertIn(f"Group {group} does not match", page.text_content("#recovery-key-error"))
                self.assertEqual(page.get_attribute("#recovery-key-confirm-group", "aria-invalid"), "true")
                self.assertTrue(page.is_visible(DIALOG_OPEN))
                self.assertEqual(wrap_rows(), [])

                # Download: a text file with the key.
                with page.expect_download() as dl_info:
                    page.click("#recovery-key-download")
                download = dl_info.value
                self.assertEqual(download.suggested_filename, "deeperguard-recovery-key.txt")
                content = Path(download.path()).read_text(encoding="utf-8")
                self.assertIn(first_key, content)
                self.assertIn(email, content)
                self.assertNotIn("seed phrase", content.lower())

                # Print: only the key sheet is printed (app and buttons hidden).
                page.emulate_media(media="print")
                page.evaluate(PRINT_PROBE_JS)
                page.click("#recovery-key-print")
                seen = page.evaluate("() => window.__printSeen")
                page.emulate_media(media="screen")
                self.assertIsNotNone(seen, "Print did not call window.print")
                self.assertTrue(seen["printing"])
                self.assertTrue(seen["valueShown"])
                self.assertEqual(seen["value"], first_key)
                self.assertFalse(seen["shellShown"])
                self.assertFalse(seen["saveShown"])
                self.assertIn(email, seen["meta"])
                page.wait_for_function("() => !document.body.classList.contains('recovery-key-printing')")

                # Network failure on save: error, retry offered, nothing stored.
                page.route(f"**{RECOVERY_PUT}", lambda route: route.abort("internetdisconnected"))
                page.fill("#recovery-key-confirm-group", first_key.split("-")[group - 1].lower())
                page.click("#recovery-key-save")
                page.wait_for_function(
                    "() => /connection/.test(document.getElementById('recovery-key-error').textContent)"
                )
                self.assertEqual(page.text_content("#recovery-key-save"), "Try again")
                self.assertTrue(page.is_visible(DIALOG_OPEN))
                self.assertEqual(wrap_rows(), [])
                page.unroute(f"**{RECOVERY_PUT}")

                # Leave without saving: the step returns at the next unlock, with a new key.
                page.reload(wait_until="domcontentloaded")
                page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
                page.fill("#unlock-password", PASSWORD)
                page.click("#unlock-submit")
                page.wait_for_function(UNLOCKED_JS, timeout=120000)
                second_key, _ = read_shown_key(page)
                self.assertNotEqual(second_key, first_key)

                # Keyboard only: tick, type the group, Enter saves.
                second_group = int(page.text_content("#recovery-key-group-number"))
                page.focus("#recovery-key-stored")
                page.keyboard.press("Space")
                page.focus("#recovery-key-confirm-group")
                page.keyboard.type(second_key.split("-")[second_group - 1])
                page.keyboard.press("Enter")
                page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=60000)
                self.assertFalse(page.is_visible("#auth-security-notice"))

                rows = wrap_rows()
                self.assertEqual(len(rows), 1)
                user_id, key_id, wrap_version, salt_b64, wrap_json, proof_hash = rows[0]
                self.assertEqual(wrap_version, 1)
                client_key_id = page.evaluate("() => NotesCrypto.vaultKeyId(NotesStore.vaultKeyCopy())")
                self.assertEqual(key_id, client_key_id)

                # The stored copy opens with the key that was shown, and not with the first one.
                opened = page.evaluate(
                    """async ([text, salt, blob, keyId, accountId]) => {
                      const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
                      const wrap = { wrap_version: 1, key_id: keyId, blob: JSON.parse(blob) };
                      try {
                        const wk = NotesCrypto.deriveRecoveryWrapKey(NotesCrypto.decodeRecoveryKey(text), saltBytes);
                        const vk = await NotesCrypto.unwrapVaultKey(wk, wrap, { accountId, type: 'recovery' });
                        return NotesCrypto.vaultKeyId(vk);
                      } catch (err) { return 'error'; }
                    }""",
                    [second_key, salt_b64, wrap_json, key_id, str(user_id)],
                )
                self.assertEqual(opened, client_key_id)
                stale = page.evaluate(
                    """async ([text, salt, blob, keyId, accountId]) => {
                      const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
                      const wrap = { wrap_version: 1, key_id: keyId, blob: JSON.parse(blob) };
                      try {
                        const wk = NotesCrypto.deriveRecoveryWrapKey(NotesCrypto.decodeRecoveryKey(text), saltBytes);
                        await NotesCrypto.unwrapVaultKey(wk, wrap, { accountId, type: 'recovery' });
                        return 'opened';
                      } catch (err) { return 'refused'; }
                    }""",
                    [first_key, salt_b64, wrap_json, key_id, str(user_id)],
                )
                self.assertEqual(stale, "refused")

                # Neither the recovery key nor the vault key reached the server.
                material = _key_material(page, second_key) + _key_material(page, first_key)[:2]
                con = sqlite3.connect(db_file)
                try:
                    dump = "\n".join(con.iterdump())
                finally:
                    con.close()
                sent = "\n".join(bodies)
                self.assertTrue(any(RECOVERY_PUT in b or "proof_hash" in b for b in bodies))
                for needle in material:
                    self.assertNotIn(needle, sent)
                    self.assertNotIn(needle, dump)
                self.assertNotIn(second_key.encode(), db_file.read_bytes())
                self.assertEqual(json.loads(wrap_json)["v"], 2)

                # Done: another unlock does not ask again.
                page.reload(wait_until="domcontentloaded")
                page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
                page.fill("#unlock-password", PASSWORD)
                page.click("#unlock-submit")
                page.wait_for_function(UNLOCKED_JS, timeout=120000)
                page.wait_for_timeout(1500)
                self.assertFalse(page.is_visible(DIALOG_OPEN))
                self.assertEqual(len(wrap_rows()), 1)
                browser.close()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            shutil.rmtree(root, ignore_errors=True)


class RecoveryKeySetupPhoneAndThemeE2E(unittest.TestCase):
    def test_step_fits_phone_width_in_dark_and_light(self):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-recovery-key-phone-"))
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        proc = start_server(root, port)
        try:
            with sync_playwright() as p:
                browser = launch(p)
                for scheme in ("dark", "light"):
                    ctx = browser.new_context(viewport={"width": 375, "height": 740}, color_scheme=scheme)
                    page = ctx.new_page()
                    register(page, base, recovery_key_step=False)
                    read_shown_key(page)
                    box = page.evaluate(
                        """() => {
                          const d = document.getElementById('recovery-key-dialog').getBoundingClientRect();
                          const v = document.getElementById('recovery-key-value');
                          const cs = getComputedStyle(v);
                          return { left: d.left, right: d.right, vw: window.innerWidth,
                                   valueOverflow: v.scrollWidth > v.clientWidth + 1,
                                   color: cs.color, bg: cs.backgroundColor };
                        }"""
                    )
                    self.assertGreaterEqual(box["left"], 0)
                    self.assertLessEqual(box["right"], box["vw"])
                    self.assertFalse(box["valueOverflow"])
                    self.assertNotEqual(box["color"], box["bg"])
                    for sel in ("#recovery-key-print", "#recovery-key-download", "#recovery-key-copy", "#recovery-key-save"):
                        page.locator(sel).scroll_into_view_if_needed()
                        self.assertTrue(page.is_visible(sel), sel)
                    complete_recovery_key_step(page)
                    ctx.close()
                browser.close()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
