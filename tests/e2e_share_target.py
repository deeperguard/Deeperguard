"""E2E (Playwright): PWA share target + quick capture shortcut.

Proves docs/REMINDERS_TASKS_SPEC.md sections 5, 6 and 9:
- a share POSTed to /app/share-target while the vault is locked is kept in
  memory only: the text is not in IndexedDB, Cache Storage, localStorage or
  sessionStorage, and the unlock screen says shared content is waiting;
- after unlock a prefilled Quick capture sheet opens and nothing is saved
  until the user presses Save; Save stores an encrypted note (plaintext never
  in IndexedDB); Cancel discards;
- a share that arrives while the vault is already unlocked opens the sheet;
- Ctrl+Shift+K opens the sheet, Ctrl+K still focuses search.

    python tests/e2e_share_target.py
"""
from __future__ import annotations

import secrets
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

DUMP_STORAGE_JS = """async () => {
  const out = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    out.push(`ls:${k}=${localStorage.getItem(k)}`);
  }
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const k = sessionStorage.key(i);
    out.push(`ss:${k}=${sessionStorage.getItem(k)}`);
  }
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      out.push(`cache:${req.url}`);
      const res = await cache.match(req);
      if (res) out.push(await res.text());
    }
  }
  const bytes = (v) => new TextDecoder('latin1').decode(
    v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  const replacer = (k, v) => ((v instanceof ArrayBuffer || ArrayBuffer.isView(v)) ? bytes(v) : v);
  for (const info of await indexedDB.databases()) {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(info.name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (const store of Array.from(db.objectStoreNames)) {
      const rows = await new Promise((resolve, reject) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      out.push(`idb:${info.name}/${store}:` + JSON.stringify(rows, replacer));
    }
    db.close();
  }
  return out.join('\\n');
}"""

SHARE_JS = """([text, title, url]) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.enctype = 'multipart/form-data';
  form.action = '/app/share-target';
  for (const [name, value] of [['text', text], ['title', title], ['url', url]]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}"""

UNLOCKED_JS = """() => !!(window.NotesStore && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked'))"""

SHEET_OPEN_JS = """(needle) => {
  const root = document.getElementById('quick-capture');
  const text = document.getElementById('quick-capture-text');
  return !!(root && !root.hidden && text && text.value.includes(needle));
}"""


def launch(p):
    try:
        return p.chromium.launch(headless=True)
    except Exception:
        exe = shutil.which("chromium") or "/usr/bin/chromium"
        return p.chromium.launch(headless=True, executable_path=exe)


def register(page, base: str) -> None:
    email = f"share-target-{int(time.time())}-{secrets.token_hex(3)}@home.local"
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
          let input = document.querySelector('input[name="cf-turnstile-response"]');
          if (!input) {
            input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'cf-turnstile-response';
            document.getElementById('register-form').appendChild(input);
          }
          input.value = 'e2e-dummy-turnstile-token';
        }"""
    )
    page.click("#register-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120000)


def wait_sw_controls(page, base: str) -> None:
    page.evaluate("() => navigator.serviceWorker.ready")
    for _ in range(3):
        if page.evaluate("() => !!navigator.serviceWorker.controller"):
            return
        page.goto(f"{base}/app", wait_until="domcontentloaded")
        page.evaluate("() => navigator.serviceWorker.ready")
    raise AssertionError("service worker never controlled /app")


def share(page, text: str, title: str = "", url: str = "") -> None:
    with page.expect_navigation(url="**/app?action=share*", wait_until="domcontentloaded"):
        page.evaluate(SHARE_JS, [text, title, url])


def note_titles(page) -> list:
    return page.evaluate("() => NotesStore.listNotes().map((n) => (n.content || n).title || '')")


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-share-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = launch(p)
            context = browser.new_context(service_workers="allow")
            page = context.new_page()
            register(page, base)
            wait_sw_controls(page, base)
            # Start from a page load without the fresh-login unlock, like a
            # share arriving later: the vault is locked after the reload.
            page.evaluate("() => sessionStorage.clear()")
            page.goto(f"{base}/app", wait_until="domcontentloaded")
            page.wait_for_selector("#unlock-screen:not([hidden])", timeout=60000)

            # 1. Share while locked.
            secret = "ZKSHARE" + secrets.token_hex(8)
            share(page, f"{secret} body line", title=f"{secret} title", url="https://example.test/x")
            page.wait_for_selector("#unlock-share-hint:not([hidden])", timeout=20000)
            hint = page.inner_text("#unlock-share-hint")
            assert "Shared content is waiting. Unlock to save it." in hint, hint
            assert not page.evaluate(UNLOCKED_JS), "vault must still be locked"
            assert "action=share" in page.url and secret not in page.url
            time.sleep(1.0)  # give any (wrong) persistence a chance to land
            dump = page.evaluate(DUMP_STORAGE_JS)
            assert "idb:" in dump, "IndexedDB dump ran"
            assert secret not in dump, "shared text leaked to browser storage while locked"

            # 2. Unlock: sheet opens prefilled, nothing saved before Save.
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120000)
            page.wait_for_function(SHEET_OPEN_JS, arg=secret, timeout=20000)
            assert page.is_hidden("#unlock-share-hint")
            assert page.is_checked("#quick-capture-note")
            before = note_titles(page)
            assert not any(secret in t for t in before), "saved without a click"
            page.click("#quick-capture-save")
            page.wait_for_selector("#quick-capture", state="hidden")
            note_titles_after_unlock = note_titles(page)
            assert any(t.startswith(f"{secret} title") for t in note_titles_after_unlock), note_titles_after_unlock
            page.evaluate("() => NotesStore.flush && NotesStore.flush()")
            time.sleep(1.0)
            dump = page.evaluate(DUMP_STORAGE_JS)
            assert secret not in dump, "note stored unencrypted"

            # 3. Share while the vault is already unlocked in another tab's
            # session (same page, no reload of the key): POST through the
            # worker, then the app asks for it -> sheet opens; Cancel discards.
            secret2 = "ZKSHARE" + secrets.token_hex(8)
            page.evaluate(
                """async (t) => {
                  const fd = new FormData();
                  fd.append('text', t);
                  await fetch('/app/share-target', { method: 'POST', body: fd, redirect: 'manual' });
                  history.replaceState(null, '', '/app?action=share');
                  window.dispatchEvent(new Event('notes-launch-action'));
                }""",
                secret2,
            )
            page.wait_for_function(SHEET_OPEN_JS, arg=secret2, timeout=20000)
            page.click("#quick-capture-cancel")
            page.wait_for_selector("#quick-capture", state="hidden")
            assert not any(secret2 in t for t in note_titles(page)), "Cancel must discard"

            # 4. Shortcut: Ctrl+Shift+K opens the sheet; Task saves a checklist.
            page.click("body")
            page.keyboard.press("Control+Shift+K")
            page.wait_for_selector("#quick-capture:not([hidden])", timeout=5000)
            task = "Task" + secrets.token_hex(4)
            page.fill("#quick-capture-text", task)
            page.click("label:has(#quick-capture-task)")
            assert page.is_checked("#quick-capture-task")
            page.keyboard.press("Control+Enter")
            page.wait_for_selector("#quick-capture", state="hidden")
            contents = page.evaluate(
                "(t) => NotesStore.listNotes().map((n) => n.content || n).filter((c) => c.title === t).map((c) => c.content)",
                task,
            )
            assert contents == [f"- [ ] {task}"], contents
            # Ctrl+K is still search, not capture.
            page.keyboard.press("Control+K")
            assert page.is_hidden("#quick-capture")
            browser.close()
        print("e2e_share_target ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
