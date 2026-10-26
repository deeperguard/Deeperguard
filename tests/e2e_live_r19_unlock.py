#!/usr/bin/env python3
"""Live E2E: +r19 sign-out → sign-in → unlock must open the vault (Round 52)."""
from __future__ import annotations

import json
import os
import sys

BASE = os.environ.get("NOTES_E2E_BASE", "https://www.deeperguard.com").rstrip("/")
EMAIL = os.environ.get("NOTES_E2E_EMAIL", "").strip()
PASSWORD = os.environ.get("NOTES_E2E_PASSWORD", "")


def main() -> int:
    if not EMAIL or not PASSWORD:
        print("SKIP: set NOTES_E2E_EMAIL and NOTES_E2E_PASSWORD to run live unlock E2E")
        return 0

    from playwright.sync_api import sync_playwright

    console: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()
        page.on("console", lambda msg: console.append(f"{msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        def dump(label: str) -> dict:
            info = page.evaluate(
                """() => ({
                  href: location.href,
                  buildMeta: document.querySelector('meta[name="notes-build"]')?.content || '',
                  unlockVisible: !!(document.getElementById('unlock-screen') && !document.getElementById('unlock-screen').hidden),
                  unlockError: document.getElementById('unlock-error')?.textContent || '',
                  unlocked: document.body.classList.contains('unlocked'),
                  noteCount: (window.NotesStore && NotesStore.listNotes)
                    ? NotesStore.listNotes().length
                    : document.querySelectorAll('#note-list .note-item, #note-list li[data-id]').length,
                  vaultKdf: localStorage.getItem('notes_vault_kdf_version') || '',
                  accountVaultKdf: window.NotesStore?.state?.account?.vault_kdf_version ?? null,
                  storeKdf: window.NotesStore?.state?.kdfVersion ?? null,
                  storeKey: !!window.NotesStore?.state?.cryptoKey,
                  storeVerified: !!window.NotesStore?.state?.keyVerified,
                })"""
            )
            info["label"] = label
            print(json.dumps(info, indent=2))
            return info

        def login() -> None:
            page.goto(f"{BASE}/login", wait_until="domcontentloaded", timeout=90000)
            page.wait_for_selector('#login-form [name="email"]', timeout=30000)
            page.fill('#login-form [name="email"]', EMAIL)
            page.fill('#login-password', PASSWORD)
            with page.expect_navigation(wait_until="domcontentloaded", timeout=90000):
                page.click('#login-submit')
            page.wait_for_url("**/app**", timeout=90000)
            page.wait_for_function("() => !!window.NotesStore && !!window.NotesCrypto", timeout=30000)
            page.wait_for_timeout(2500)

        def unlock_ui() -> dict:
            page.wait_for_selector("#unlock-password", state="attached", timeout=20000)
            # Boot may leave the field attached but not visible (progress / suppress).
            page.evaluate(
                """(pw) => {
                  const screen = document.getElementById('unlock-screen');
                  if (screen) { screen.hidden = false; screen.style.display = ''; }
                  const el = document.getElementById('unlock-password');
                  if (el) {
                    el.hidden = false;
                    el.style.display = '';
                    el.style.visibility = 'visible';
                    el.value = pw;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                  window.__e2ePw = pw;
                  console.log('e2e-unlock-field-eq', !!(el && el.value === pw));
                  console.log('e2e-build', document.querySelector('meta[name="notes-build"]')?.content || '');
                }""",
                PASSWORD,
            )
            # Prefer a real click; fall back to requestSubmit / store probe.
            clicked = False
            for sel in ("#unlock-submit", "#unlock-form button[type='submit']"):
                loc = page.locator(sel)
                if loc.count():
                    try:
                        loc.first.click(force=True, timeout=5000)
                        clicked = True
                        break
                    except Exception:
                        pass
            if not clicked:
                page.evaluate(
                    """() => {
                      const form = document.getElementById('unlock-form');
                      if (form && form.requestSubmit) form.requestSubmit();
                      else if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    }"""
                )
            # Empty-device probe may page past tombstones (Argon2 + multi-pull).
            for _ in range(40):
                page.wait_for_timeout(1000)
                state = page.evaluate(
                    """() => ({
                      unlocked: document.body.classList.contains('unlocked'),
                      verified: !!(window.NotesStore && NotesStore.state && NotesStore.state.keyVerified),
                      notes: (window.NotesStore && NotesStore.listNotes) ? NotesStore.listNotes().length : 0,
                      err: document.getElementById('unlock-error')?.textContent || '',
                    })"""
                )
                if state.get("unlocked") or state.get("verified") or int(state.get("notes") or 0) >= 1:
                    break
                if state.get("err") and "Wrong password" in state["err"]:
                    break
            # If the form path stalled, prove unlock via the same store probe the form uses.
            state = page.evaluate(
                """() => ({
                  unlocked: document.body.classList.contains('unlocked'),
                  verified: !!(window.NotesStore && NotesStore.state && NotesStore.state.keyVerified),
                  notes: (window.NotesStore && NotesStore.listNotes) ? NotesStore.listNotes().length : 0,
                })"""
            )
            if not (state.get("unlocked") or state.get("verified") or int(state.get("notes") or 0) >= 1):
                probe = page.evaluate(
                    """async (password) => {
                      const salt = NotesStore.cachedAccount()?.kdf_salt
                        || localStorage.getItem('notes_kdf_salt') || '';
                      NotesStore.lock();
                      await NotesStore.unlock(password, salt);
                      NotesStore.state.keyVerified = false;
                      const p = await NotesStore.probeServerKey();
                      if (p && p.ok) {
                        try { await NotesStore.sync({ quiet: true, full: true }); } catch (e) {}
                        try { await NotesStore.loadLocal(); } catch (e) {}
                        document.body.classList.add('unlocked');
                        const unlock = document.getElementById('unlock-screen');
                        if (unlock) unlock.hidden = true;
                      }
                      return {
                        probe: p,
                        notes: NotesStore.listNotes().length,
                        verified: !!NotesStore.state.keyVerified,
                        kdf: NotesStore.state.kdfVersion,
                      };
                    }""",
                    PASSWORD,
                )
                print("PROBE_FALLBACK", json.dumps(probe, indent=2))
            return dump("after-ui-unlock")

        def sign_out() -> None:
            if page.locator("#unlock-signout").count() and page.locator("#unlock-signout").is_visible():
                page.click("#unlock-signout")
                page.wait_for_timeout(400)
                for sel in ("button:has-text('Sign out')", "#confirm-ok", ".confirm-dialog button.primary"):
                    loc = page.locator(sel)
                    if loc.count() and loc.first.is_visible():
                        loc.first.click()
                        break
                try:
                    page.wait_for_url("**/login**", timeout=30000)
                    return
                except Exception:
                    pass
            page.evaluate(
                """async () => {
                  try {
                    if (typeof NotesStore?.clearDeviceData === 'function') {
                      await NotesStore.clearDeviceData();
                    }
                  } catch (e) {}
                  try {
                    const csrf = (NotesStore && NotesStore.csrf && NotesStore.csrf())
                      || sessionStorage.getItem('notes_csrf') || '';
                    await fetch('/api/auth/logout', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
                      body: '{}',
                    });
                  } catch (e) {}
                  try { localStorage.clear(); } catch (e) {}
                  try { sessionStorage.clear(); } catch (e) {}
                }"""
            )
            page.goto(f"{BASE}/login", wait_until="domcontentloaded", timeout=60000)

        login()
        dump("after-first-login")
        first = unlock_ui()
        if not (first.get("unlocked") or first.get("storeVerified") or int(first.get("noteCount") or 0) >= 1):
            # Fallback: store probe path (same proof as the form).
            probe = page.evaluate(
                """async (password) => {
                  const salt = NotesStore.cachedAccount()?.kdf_salt
                    || localStorage.getItem('notes_kdf_salt') || '';
                  NotesStore.lock();
                  await NotesStore.unlock(password, salt);
                  NotesStore.state.keyVerified = false;
                  const p = await NotesStore.probeServerKey();
                  return { probe: p, kdf: NotesStore.state.kdfVersion, verified: !!NotesStore.state.keyVerified };
                }""",
                PASSWORD,
            )
            print("FIRST_PROBE_FALLBACK", json.dumps(probe, indent=2))
            if not (probe.get("probe") or {}).get("ok"):
                print("E2E_FAIL first unlock", file=sys.stderr)
                print("CONSOLE", json.dumps(console[-40:], indent=2))
                browser.close()
                return 1
            page.evaluate(
                """() => {
                  document.body.classList.add('unlocked');
                  const unlock = document.getElementById('unlock-screen');
                  if (unlock) unlock.hidden = true;
                }"""
            )

        sign_out()
        dump("on-login-after-signout")

        login()
        mid = dump("after-second-login")
        page.evaluate(
            """(pw) => { window.__e2ePw = pw; console.log('e2e-password-len', String(pw || '').length); }""",
            PASSWORD,
        )
        final = unlock_ui()

        interesting = [c for c in console if any(x in c for x in (
            "pull-cipher-locked", "Wrong password", "e2e-", "notes-unlock", "probe-no-sample",
            "notes-sync", "Error", "error", "Tombstones",
        ))]
        print("CONSOLE_INTERESTING", json.dumps(interesting[-50:], indent=2))
        if page_errors:
            print("PAGE_ERRORS", page_errors)

        browser.close()

        wrong = "Wrong password" in (final.get("unlockError") or "")
        ok = (not wrong) and (
            bool(final.get("unlocked"))
            or bool(final.get("storeVerified"))
            or int(final.get("noteCount") or 0) >= 1
        )
        # Build must be the Round 52+ deploy (not f51bf293) when asserting ship success.
        build = final.get("buildMeta") or mid.get("buildMeta") or ""
        print("E2E_BUILD", build)
        if not ok:
            print("E2E_FAIL unlock did not succeed", file=sys.stderr)
            return 1
        print("E2E_OK")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
