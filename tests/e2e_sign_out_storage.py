"""E2E: Sign out in Settings clears the session and key material, also after a reload (docs/LOGOUT.md).

    python tests/e2e_sign_out_storage.py
"""
from __future__ import annotations

import json
import shutil
import tempfile
import time
from pathlib import Path

from e2e_register_after_signout import SERVER_ENV, Browser, register_first_account
from e2e_signup_autounlock import free_port, start_server

STORAGE_JS = """async () => {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i += 1) { const k = s.key(i); o[k] = String(s.getItem(k)).slice(0, 60); } return o; };
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  const idb = {};
  for (const info of dbs) {
    idb[info.name] = await new Promise((resolve) => {
      const req = indexedDB.open(info.name);
      req.onerror = () => resolve({ error: String(req.error) });
      req.onsuccess = () => {
        const db = req.result;
        const out = {};
        const names = Array.from(db.objectStoreNames);
        if (!names.length) { db.close(); resolve(out); return; }
        const tx = db.transaction(names, 'readonly');
        let left = names.length;
        names.forEach((n) => {
          const c = tx.objectStore(n).count();
          c.onsuccess = () => { out[n] = c.result; left -= 1; if (left === 0) { db.close(); resolve(out); } };
        });
      };
    });
  }
  return { local: dump(localStorage), session: dump(sessionStorage), idb };
}"""

UNLOCKED_JS = "() => document.body.classList.contains('unlocked')"


def sign_out_and_inspect() -> dict:
    """Register, sign out through Settings, reload; return storage before/after and the old cookies."""
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-sign-out-storage-"))
    port = free_port()
    proc = start_server(root, port, SERVER_ENV)
    try:
        with sync_playwright() as p:
            b = Browser(p, f"http://127.0.0.1:{port}")
            try:
                register_first_account(b, f"signout-storage-{int(time.time() * 1000)}@home.local")
                page = b.page
                page.wait_for_function(UNLOCKED_JS)
                before = page.evaluate(STORAGE_JS)
                old_cookies = b.context.cookies()
                page.click("#btn-settings-nav")
                page.wait_for_selector("#settings-panel:not([hidden])")
                page.click("#btn-logout")
                page.locator("[role=dialog] button, dialog button", has_text="Sign out").last.click()
                page.wait_for_url("**/login*", timeout=30000)
                page.reload(wait_until="domcontentloaded")
                page.wait_for_timeout(1500)
                result = {
                    "before": before,
                    "after": page.evaluate(STORAGE_JS),
                    "unlocked_after_reload": page.evaluate(UNLOCKED_JS),
                    "path_after_reload": page.evaluate("() => location.pathname"),
                    "cookies_after": [c["name"] for c in b.context.cookies()],
                    "old_cookies": old_cookies,
                    "base": b.base,
                }
                # Replay the old cookies in a fresh context: the server must refuse them.
                replay = p.chromium.launch(headless=True)
                try:
                    ctx = replay.new_context()
                    ctx.add_cookies(old_cookies)
                    res = ctx.request.get(f"{b.base}/api/account")
                    result["replay_status"] = res.status
                finally:
                    replay.close()
                return result
            finally:
                b.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    r = sign_out_and_inspect()
    r["old_cookies"] = [c["name"] for c in r["old_cookies"]]
    print(json.dumps(r, indent=1))
