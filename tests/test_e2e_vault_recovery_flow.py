"""Forgot password: recover the vault with the recovery key (docs/VAULT_RECOVERY.md 3.2, 7.1).

Real server and Chromium, two signed-in devices (browser contexts) on one account:

* the sign-in page leads to the recovery form; a mistyped and a valid-format but
  wrong key give clear errors and change nothing on the server;
* an interruption between the pending checkpoint and the end of the re-encrypt
  push (E8) leaves the account usable; the other device edits meanwhile; an
  expired checkpoint (P11) asks for the earlier new password; finishing works,
  the new password signs in, every note, the edits of the other device and an
  attachment are readable, the old recovery key is refused, the other device is
  signed out;
* a failed commit (403, 409, offline) rolls back without overwriting what the
  other device wrote in between, and a later attempt with another new password
  finishes from the live checkpoint;
* a 429 with retry_after on recover/start (attempt lock, 3.3) shows the wait
  and changes nothing.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402
from e2e_share_target import UNLOCKED_JS, launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

P1 = "first-new-pass-4411"
P2 = "second-new-pass-8822"
ATTACHMENT_TEXT = "attachment secret bytes 7f3a"

SEED_JS = """async (attText) => {
  const notes = {};
  for (const title of ['Alpha note', 'Beta note', 'Gamma note']) {
    const id = NotesStore.newUuid();
    NotesStore.upsert(id, { ...NotesStore.defaultNote(), title, title_manual: true, content: title + ' body' });
    notes[title] = id;
  }
  const noteId = notes['Alpha note'];
  const file = new File([new TextEncoder().encode(attText)], 'secret.txt', { type: 'text/plain' });
  const att = await NotesStore.addAttachment(noteId, file, { displayName: 'secret.txt' });
  await NotesStore.flush();
  return { notes, att };
}"""

# Reads the server rows with the key the given password derives; null when a row does not open.
READ_SERVER_JS = """async ([password, uuids]) => {
  const acct = await NotesStore.api('/api/account');
  const derived = await NotesCrypto.deriveKey(password, acct.kdf_salt, { kdfVersion: acct.vault_kdf_version });
  const key = derived.key || derived;
  const data = await NotesStore.api('/api/sync/refetch', {
    method: 'POST', body: JSON.stringify({ uuids, include_blobs: 1 }),
  });
  const out = {};
  for (const row of data.items || []) {
    try {
      const content = await NotesCrypto.decryptObject(key, JSON.parse(row.ciphertext));
      let file = null;
      if (row.blob_ciphertext) {
        file = new TextDecoder().decode(await NotesCrypto.decryptBytes(key, JSON.parse(row.blob_ciphertext)));
      }
      out[row.item_uuid] = { text: content.content || content.filename || '', file };
    } catch (err) { out[row.item_uuid] = null; }
  }
  return out;
}"""

EDIT_JS = """async ([uuids, suffix]) => {
  for (const id of uuids) {
    const item = NotesStore.get(id);
    NotesStore.upsert(id, { ...item.content, content: item.content.content + suffix });
  }
  await NotesStore.flush();
}"""

RECOVER_JS = """async ([key, password]) => {
  try {
    await NotesStore.recoverWithRecoveryKey(key, password, { confirmNewKey: async () => {} });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code || '', message: err.message, rolledBack: !!err.rolledBack };
  }
}"""


def sign_in(page, base, email, password):
    page.goto(f"{base}/login", wait_until="domcontentloaded")
    page.fill('form#login-form input[name="email"]', email)
    page.fill("#login-password", password)
    page.click("#login-submit")
    page.wait_for_url("**/app*", timeout=60000)
    page.wait_for_function(
        """() => (window.NotesStore && NotesStore.isUnlocked())
          || (document.getElementById('unlock-password')?.getClientRects().length || 0) > 0""",
        timeout=120000,
    )
    if not page.evaluate("() => NotesStore.isUnlocked()"):
        page.fill("#unlock-password", password)
        page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120000)


class VaultRecoveryFlowE2E(unittest.TestCase):
    def setUp(self):
        from playwright.sync_api import sync_playwright

        self.root = Path(tempfile.mkdtemp(prefix="e2e-vault-recovery-"))
        port = free_port()
        self.base = f"http://127.0.0.1:{port}"
        # Every attempt makes four calls through the per-IP limiter (3.3); this test makes several.
        self.proc = start_server(self.root, port, {"NOTES_AUTH_RATE_LIMIT": "200", "NOTES_AUTH_RATE_LIMIT_WAN": "200"})
        self.addCleanup(shutil.rmtree, self.root, True)
        self.addCleanup(self._stop_server)
        self.pw = sync_playwright().start()
        self.addCleanup(self.pw.stop)
        self.browser = launch(self.pw)
        self.addCleanup(self.browser.close)

    def _stop_server(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=8)
        except Exception:
            self.proc.kill()

    def _db(self, sql, args=()):
        con = sqlite3.connect(self.root / "data" / "notes.db")
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def _account(self, email):
        uid, verifier, failed = self._db(
            "SELECT id, srp_verifier, recovery_failed_count FROM users WHERE email = ?", (email,))[0]
        proof_hash = self._db("SELECT proof_hash FROM vault_recovery_wraps WHERE user_id = ?", (uid,))[0][0]
        pending = self._db("SELECT to_key_id FROM vault_pending_rekey WHERE user_id = ?", (uid,))
        rows = dict(self._db("SELECT item_uuid, ciphertext FROM items WHERE user_id = ?", (uid,)))
        return {"uid": uid, "verifier": verifier, "failed": failed, "proof_hash": proof_hash,
                "pending": pending, "rows": rows}

    def _devices(self):
        """Device A registers (with its recovery key) and seeds; device B signs in and unlocks."""
        a = self.browser.new_context(viewport={"width": 1280, "height": 860}).new_page()
        email = register(a, self.base, recovery_key_step=False)
        key = complete_recovery_key_step(a)
        seeded = a.evaluate(SEED_JS, ATTACHMENT_TEXT)
        b = self.browser.new_context(viewport={"width": 390, "height": 800}).new_page()
        sign_in(b, self.base, email, PASSWORD)
        b.wait_for_function(
            "(ids) => ids.every((id) => NotesStore.get(id))", arg=list(seeded["notes"].values()), timeout=60000)
        return a, b, email, key, seeded

    def test_forgot_password_ui_interrupted_resumed_and_new_password_signs_in(self):
        a, b, email, key, seeded = self._devices()
        notes = seeded["notes"]
        all_ids = list(notes.values()) + [seeded["att"]]
        before = self._account(email)

        # Sign-in page: "Forgot your password?" leads to the recovery form (the key is typed there).
        a.goto(f"{self.base}/login", wait_until="domcontentloaded")
        a.click("#login-toggle-recoverkey")
        self.assertEqual(a.get_attribute("#login-toggle-recoverkey", "aria-expanded"), "true")
        a.fill('form#login-form input[name="email"]', email)
        a.click("#login-recoverkey-submit")
        a.wait_for_selector("#recover-form:not([hidden])", timeout=60000)
        self.assertEqual(a.evaluate("() => document.activeElement.id"), "recover-key")
        self.assertIsNone(a.evaluate("() => sessionStorage.getItem('notes_recover_intent')"))

        # A mistyped key and a valid-format wrong key: clear errors, nothing changes.
        a.fill("#recover-key", key[:-1] + ("0" if key[-1] != "0" else "1"))
        a.fill("#recover-new", P1)
        a.fill("#recover-new2", P1)
        a.click("#recover-submit")
        a.wait_for_function(
            "() => /not a valid recovery key/.test(document.getElementById('recover-error').textContent)")
        wrong = a.evaluate("() => NotesCrypto.encodeRecoveryKey(NotesCrypto.generateRecoveryKey())")
        a.fill("#recover-key", wrong)
        a.click("#recover-submit")
        a.wait_for_function(
            "() => /does not open this vault/.test(document.getElementById('recover-error').textContent)",
            timeout=60000)
        self.assertIn("Nothing was changed", a.text_content("#recover-error"))
        self.assertEqual(a.get_attribute("#recover-key", "aria-invalid"), "true")
        self.assertEqual(self._account(email), before)

        # E8: the push is cut off after one row (then the network to /api/sync/items is gone).
        calls = {"n": 0}

        def cut_push(route):
            calls["n"] += 1
            if calls["n"] > 1:
                route.abort("internetdisconnected")
                return
            body = json.loads(route.request.post_data)
            body["items"] = body["items"][:1]
            route.fulfill(response=route.fetch(post_data=json.dumps(body)))

        a.route("**/api/sync/items", cut_push)
        a.fill("#recover-key", key)
        a.click("#recover-submit")
        a.wait_for_selector("#recover-step-show:not([hidden])", timeout=120000)
        a.check("#recover-stored")
        a.click("#recover-finish")
        a.wait_for_selector("#recover-error:not([hidden])", timeout=120000)
        self.assertIn("Start again with the same recovery key", a.text_content("#recover-error"))
        a.unroute("**/api/sync/items")
        mid = self._account(email)
        self.assertEqual(mid["verifier"], before["verifier"])
        self.assertEqual(mid["proof_hash"], before["proof_hash"])
        self.assertEqual(len(mid["pending"]), 1)
        moved = [u for u in all_ids if mid["rows"][u] != before["rows"][u]]
        self.assertEqual(len(moved), 1, moved)
        # Old password still opens every untouched row; the moved one opens with P1 only.
        with_old = a.evaluate(READ_SERVER_JS, [PASSWORD, all_ids])
        with_p1 = a.evaluate(READ_SERVER_JS, [P1, all_ids])
        for uuid in all_ids:
            self.assertEqual(with_old[uuid] is None, uuid in moved, uuid)
            self.assertEqual(with_p1[uuid] is not None, uuid in moved, uuid)

        # Device B, still signed in, edits the notes that were not moved yet.
        b_edited = [u for u in notes.values() if u not in moved]
        b.evaluate(EDIT_JS, [b_edited, " +edited on B"])

        # P11: the checkpoint expires; another new password cannot open the moved row.
        con = sqlite3.connect(self.root / "data" / "notes.db")
        con.execute("UPDATE vault_pending_rekey SET expires_at = 1")
        con.commit()
        con.close()
        a.reload(wait_until="domcontentloaded")  # the tab was closed
        a.wait_for_selector("#unlock-password", state="visible", timeout=60000)
        a.click("#unlock-forgot")
        a.fill("#recover-key", key)
        a.fill("#recover-new", P2)
        a.fill("#recover-new2", P2)
        a.click("#recover-submit")
        a.wait_for_selector("#recover-step-show:not([hidden])", timeout=120000)
        a.check("#recover-stored")
        a.click("#recover-finish")
        a.wait_for_function(
            "() => /different new password/.test(document.getElementById('recover-error').textContent)",
            timeout=120000)
        after_p2 = self._account(email)
        self.assertEqual(after_p2["verifier"], before["verifier"])
        self.assertEqual(after_p2["proof_hash"], before["proof_hash"])
        unreadable = a.text_content("#recover-error")
        self.assertIn("If you no longer know it", unreadable)
        self.assertIn("cannot be opened without that password", unreadable)
        self.assertIn("a new recovery attempt with it restores them", unreadable)

        # The same recovery key with the earlier new password finishes the recovery.
        a.fill("#recover-new", P1)
        a.fill("#recover-new2", P1)
        a.click("#recover-submit")
        a.wait_for_selector("#recover-step-show:not([hidden])", timeout=120000)
        new_key = a.text_content("#recover-newkey").strip()
        self.assertRegex(new_key, r"^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{2}$")
        self.assertNotEqual(new_key, key)
        self.assertTrue(a.is_disabled("#recover-finish"))
        a.check("#recover-stored")
        a.click("#recover-finish")
        a.wait_for_selector("#recover-step-done:not([hidden])", timeout=180000)
        done = self._account(email)
        self.assertNotEqual(done["verifier"], before["verifier"])
        self.assertNotEqual(done["proof_hash"], before["proof_hash"])
        self.assertEqual(done["pending"], [])
        revoked = self._db(
            "SELECT COUNT(*) FROM user_sessions WHERE user_id = ? AND revoke_reason = 'vault-recovery'",
            (done["uid"],))[0][0]
        self.assertGreaterEqual(revoked, 1)

        # The old recovery key is refused now.
        result = a.evaluate(RECOVER_JS, [key, "another-pass-1234"])
        self.assertEqual(result["code"], "RECOVERY_KEY_WRONG", result)

        # A fresh device: the old password fails, the new one signs in and every note is readable.
        c = self.browser.new_context().new_page()
        c.goto(f"{self.base}/login", wait_until="domcontentloaded")
        c.fill('form#login-form input[name="email"]', email)
        c.fill("#login-password", PASSWORD)
        c.click("#login-submit")
        c.wait_for_selector("#login-error:not([hidden])", timeout=60000)
        sign_in(c, self.base, email, P1)
        c.wait_for_function(
            "(ids) => ids.every((id) => NotesStore.get(id))", arg=list(notes.values()), timeout=60000)
        texts = c.evaluate("(ids) => ids.map((id) => NotesStore.get(id).content.content)", list(notes.values()))
        for title, text in zip(notes, texts):
            self.assertTrue(text.startswith(title + " body"), text)
            self.assertEqual(text.endswith(" +edited on B"), notes[title] in b_edited, text)
        with_new = c.evaluate(READ_SERVER_JS, [P1, all_ids])
        self.assertTrue(all(with_new[u] is not None for u in all_ids), with_new)
        self.assertEqual(with_new[seeded["att"]]["file"], ATTACHMENT_TEXT)

    def test_failed_commit_rolls_back_without_overwriting_other_device(self):
        a, b, email, key, seeded = self._devices()
        notes = seeded["notes"]
        all_ids = list(notes.values()) + [seeded["att"]]
        alpha = notes["Alpha note"]
        before = self._account(email)

        modes = [("403", "refused this recovery key"), ("409", "changed on another device"),
                 ("offline", "connection to the server was lost")]
        def failing_commit(mode):
            def fail_commit(route):
                # Device B writes between the re-encrypt push and the commit.
                b.evaluate(EDIT_JS, [[alpha], f" +B-{mode}"])
                if mode == "offline":
                    route.abort("internetdisconnected")
                else:
                    route.fulfill(status=int(mode), content_type="application/json",
                                  body=json.dumps({"error": "refused"}))
            return fail_commit

        for mode, phrase in modes:
            fail_commit = failing_commit(mode)
            a.route("**/api/account/vault-keys/recover/commit", fail_commit)
            result = a.evaluate(RECOVER_JS, [key, P1])
            a.unroute("**/api/account/vault-keys/recover/commit")
            self.assertFalse(result["ok"], result)
            self.assertIn(phrase, result["message"])
            self.assertTrue(result["rolledBack"], result)
            self.assertIn("put back as they were", result["message"])
            state = self._account(email)
            self.assertEqual(state["verifier"], before["verifier"], mode)
            self.assertEqual(state["proof_hash"], before["proof_hash"], mode)
            self.assertEqual(len(state["pending"]), 1, mode)
            rows = a.evaluate(READ_SERVER_JS, [PASSWORD, all_ids])
            self.assertTrue(all(rows[u] is not None for u in all_ids), (mode, rows))
            self.assertTrue(rows[alpha]["text"].endswith(f" +B-{mode}"), rows[alpha])
            self.assertEqual(rows[seeded["att"]]["file"], ATTACHMENT_TEXT)

        # Another new password while the checkpoint of P1 is live: finishes, nothing lost.
        a.reload(wait_until="domcontentloaded")
        a.wait_for_selector("#unlock-password", state="visible", timeout=60000)
        result = a.evaluate(RECOVER_JS, [key, P2])
        self.assertTrue(result["ok"], result)
        done = self._account(email)
        self.assertNotEqual(done["verifier"], before["verifier"])
        self.assertEqual(done["pending"], [])
        rows = a.evaluate(READ_SERVER_JS, [P2, all_ids])
        self.assertTrue(all(rows[u] is not None for u in all_ids), rows)
        self.assertTrue(rows[alpha]["text"].endswith(" +B-403 +B-409 +B-offline"), rows[alpha])
        self.assertEqual(rows[seeded["att"]]["file"], ATTACHMENT_TEXT)

    def test_recovery_locked_429_shows_the_wait_and_changes_nothing(self):
        a = self.browser.new_context(viewport={"width": 1280, "height": 860}).new_page()
        email = register(a, self.base, recovery_key_step=False)
        key = complete_recovery_key_step(a)
        before = self._account(email)

        a.goto(f"{self.base}/login", wait_until="domcontentloaded")
        a.click("#login-toggle-recoverkey")
        a.fill('form#login-form input[name="email"]', email)
        a.click("#login-recoverkey-submit")
        a.wait_for_selector("#recover-form:not([hidden])", timeout=60000)

        # The server is locked out of recovery (3.3): recover/start answers 429 with retry_after.
        calls = {"n": 0}

        def locked(route):
            calls["n"] += 1
            route.fulfill(status=429, content_type="application/json",
                          body=json.dumps({"error": "recovery locked", "retry_after": 900}))

        a.route("**/api/account/vault-keys/recover/start", locked)
        a.fill("#recover-key", key)
        a.fill("#recover-new", P1)
        a.fill("#recover-new2", P1)
        a.click("#recover-submit")
        a.wait_for_function(
            "() => /locked for about 15 minutes/.test(document.getElementById('recover-error').textContent)",
            timeout=60000)
        a.unroute("**/api/account/vault-keys/recover/start")
        self.assertEqual(calls["n"], 1)
        message = a.text_content("#recover-error")
        self.assertIn("Too many wrong recovery key attempts", message)
        self.assertIn("Your password still works if you remember it.", message)
        self.assertEqual(self._account(email), before)


if __name__ == "__main__":
    unittest.main()
