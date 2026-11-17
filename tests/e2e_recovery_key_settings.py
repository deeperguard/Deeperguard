"""E2E: recovery key status, create and regenerate in Settings (docs/VAULT_RECOVERY.md 3.1, 3.4).

Checks in a real browser that the settings show active/not active with a date and never
the key afterwards, that the old key stops opening the wrap once a new one is made,
and that a conflict with another device shows a message and overwrites nothing.

    python tests/e2e_recovery_key_settings.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

PASSWORD = "e2e-recovery-key-12"

# Opens the server's wrap with a recovery key text; true when it yields the vault key.
OPEN_WRAP = """async (keyText) => {
  const C = NotesCrypto;
  const st = await NotesStore.api('/api/account/vault-keys');
  const start = await NotesStore.api('/api/account/vault-keys/recover/start', { method: 'POST', body: '{}' });
  try {
    const wrapKey = C.deriveRecoveryWrapKey(C.decodeRecoveryKey(keyText), Uint8Array.from(atob(start.recovery_salt), (c) => c.charCodeAt(0)));
    const vk = await C.unwrapVaultKey(wrapKey, { wrap_version: start.wrap_version, key_id: start.key_id, blob: start.wrap },
      { accountId: st.account_id, type: 'recovery' });
    return C.vaultKeyId(vk) === C.vaultKeyId(NotesStore.vaultKeyHandle());
  } catch (err) {
    return false;
  }
}"""

# Another device replaces the recovery key between our prepare and activate steps.
OTHER_DEVICE = """async (password) => {
  const C = NotesCrypto;
  const st = await NotesStore.api('/api/account/vault-keys');
  const bytes = C.generateRecoveryKey();
  const salt = C.generateRecoverySalt();
  const wrap = await C.wrapVaultKey(NotesStore.vaultKeyHandle(), C.deriveRecoveryWrapKey(bytes, salt), { accountId: st.account_id, type: 'recovery' });
  const proof = C.hkdfSha256(bytes, salt, 'deeperguard/recovery-proof/v1', 32);
  const acct = await NotesStore.loadAccount();
  const t = await NotesSrpAuth.vaultKeysProve(acct.email, password);
  let bin = ''; salt.forEach((b) => { bin += String.fromCharCode(b); });
  await NotesStore.api('/api/account/vault-keys/recovery', { method: 'PUT', body: JSON.stringify({
    token: t.token, expected_key_rev: st.key_rev, key_id: wrap.key_id, wrap_version: wrap.wrap_version,
    recovery_salt: btoa(bin), wrap: wrap.blob, proof_hash: await C.hashBytes(proof) }) });
  return C.encodeRecoveryKey(bytes);
}"""


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-reckey-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        email = f"reckey-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context().new_page()
            page.goto(f"{base}/register", wait_until="domcontentloaded")
            page.wait_for_selector("#register-form")
            page.fill('input[name="email"]', email)
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.evaluate(
                """() => {
                  document.querySelectorAll('.cf-turnstile').forEach((el) => el.remove());
                  const input = document.createElement('input');
                  input.type = 'hidden';
                  input.name = 'cf-turnstile-response';
                  input.value = 'e2e-dummy-turnstile-token';
                  document.getElementById('register-form').appendChild(input);
                }"""
            )
            page.click("#register-submit")
            page.wait_for_function(
                "() => location.pathname === '/app' && window.NotesStore && NotesStore.isUnlocked() && document.body.classList.contains('unlocked')",
                timeout=120000,
            )
            page.evaluate("() => document.getElementById('btn-settings-head').click()")
            page.wait_for_selector("#recovery-key-settings", state="visible")
            status = page.locator("#recovery-key-status")
            page.wait_for_function("() => /not set up/.test(document.getElementById('recovery-key-status').textContent)")
            check(page.locator("#btn-recovery-key-create").is_visible(), "create button missing")
            check(not page.locator("#btn-recovery-key-regenerate").is_visible(), "regenerate shown without a key")

            def make_key() -> str:
                page.fill("#recovery-key-password", PASSWORD)
                page.locator("#btn-recovery-key-create, #btn-recovery-key-regenerate").locator("visible=true").first.click()
                page.wait_for_selector("#recovery-key-text", state="visible")
                return page.locator("#recovery-key-text").inner_text()

            # First key: the activate button needs the confirmation first.
            key1 = make_key()
            check(len(key1.replace("-", "")) == 34, f"unexpected key format {key1!r}")
            check(page.locator("#btn-recovery-key-save").is_disabled(), "activate enabled before confirming")
            page.check("#recovery-key-confirm")
            page.click("#btn-recovery-key-save")
            page.wait_for_function("() => /active since/.test(document.getElementById('recovery-key-status').textContent)")
            check(key1 not in page.locator("#recovery-key-settings").inner_text(), "key still visible after activation")
            check(not page.locator("#recovery-key-reveal").is_visible(), "reveal still open")
            check(page.locator("#btn-recovery-key-regenerate").is_visible(), "regenerate missing once active")
            check(page.evaluate(OPEN_WRAP, key1), "new key does not open the wrap")

            # Regenerate (the warning dialog is accepted): old key stops working, new one works.
            page.once("dialog", lambda d: (check("stops working" in d.message, d.message), d.accept()))
            key2 = make_key()
            check(key2 != key1, "same key twice")
            page.check("#recovery-key-confirm")
            page.click("#btn-recovery-key-save")
            page.wait_for_function("() => /Any earlier recovery key no longer works/.test(document.getElementById('recovery-key-status').textContent)")
            check(not page.evaluate(OPEN_WRAP, key1), "old key still works after regenerating")
            check(page.evaluate(OPEN_WRAP, key2), "new key does not work")
            check(key2 not in page.locator("#recovery-key-settings").inner_text(), "key visible after activation")

            # Conflict: another device replaces the key while ours is on screen.
            page.once("dialog", lambda d: d.accept())
            key3 = make_key()
            other = page.evaluate(OTHER_DEVICE, PASSWORD)
            page.check("#recovery-key-confirm")
            page.click("#btn-recovery-key-save")
            page.wait_for_function("() => /Another device changed/.test(document.getElementById('recovery-key-status').textContent)")
            check(not page.locator("#recovery-key-reveal").is_visible(), "key still shown after conflict")
            check(page.evaluate(OPEN_WRAP, other), "other device's key was overwritten")
            check(not page.evaluate(OPEN_WRAP, key3), "conflicting key was stored")
            check(page.locator("#btn-recovery-key-regenerate").is_visible(), "status not reloaded")
            browser.close()
        print("e2e_recovery_key_settings ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
