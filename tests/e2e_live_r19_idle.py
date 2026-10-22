#!/usr/bin/env python3
"""Live E2E: +r19 stays unlocked for 3 minutes while the tab stays visible (Round 53)."""
from __future__ import annotations

import json
import os
import sys
import time

BASE = os.environ.get("NOTES_E2E_BASE", "https://www.deeperguard.com").rstrip("/")
EMAIL = os.environ.get("NOTES_E2E_EMAIL", "").strip()
PASSWORD = os.environ.get("NOTES_E2E_PASSWORD", "")
TRIALS = int(os.environ.get("NOTES_E2E_IDLE_TRIALS", "3"))
IDLE_SEC = int(os.environ.get("NOTES_E2E_IDLE_SEC", "180"))


def main() -> int:
    if not EMAIL or not PASSWORD:
        print("SKIP: set NOTES_E2E_EMAIL and NOTES_E2E_PASSWORD to run live idle E2E")
        return 0

    from playwright.sync_api import sync_playwright

    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for trial in range(1, TRIALS + 1):
            console: list[str] = []
            context = browser.new_context(ignore_https_errors=True)
            page = context.new_page()
            page.on("console", lambda msg: console.append(f"{msg.type}: {msg.text}"))

            page.goto(f"{BASE}/login", wait_until="domcontentloaded", timeout=90000)
            page.fill('#login-form [name="email"]', EMAIL)
            page.fill('#login-form [name="password"]', PASSWORD)
            with page.expect_navigation(wait_until="domcontentloaded", timeout=90000):
                page.click('#login-form button[type="submit"]')
            page.wait_for_function(
                "() => !!window.NotesStore && (document.body.classList.contains('unlocked') || !!NotesStore.state?.keyVerified)",
                timeout=90000,
            )
            page.wait_for_timeout(4000)

            # Ensure unlocked (boot silent unlock should have done this on Round 52+).
            state = page.evaluate(
                """() => ({
                  unlocked: document.body.classList.contains('unlocked'),
                  verified: !!NotesStore.state?.keyVerified,
                  notes: NotesStore.listNotes ? NotesStore.listNotes().length : 0,
                  build: document.querySelector('meta[name="notes-build"]')?.content || '',
                  visibility: document.visibilityState,
                  lockOnUnfocus: (JSON.parse(localStorage.getItem('deeperguard-prefs')||'{}').lockOnUnfocus)||'',
                  autoLockMin: (JSON.parse(localStorage.getItem('deeperguard-prefs')||'{}').autoLockMin)??null,
                })"""
            )
            print(f"TRIAL{trial}_START", json.dumps(state))
            if not (state.get("unlocked") or state.get("verified")):
                page.evaluate(
                    """async (password) => {
                      const salt = NotesStore.cachedAccount()?.kdf_salt
                        || localStorage.getItem('notes_kdf_salt') || '';
                      await NotesStore.unlock(password, salt);
                      NotesStore.state.keyVerified = false;
                      const probe = await NotesStore.probeServerKey();
                      if (probe.ok) {
                        try { await NotesStore.sync({ quiet: true, full: true }); } catch (e) {}
                        try { await NotesStore.loadLocal(); } catch (e) {}
                        document.body.classList.add('unlocked');
                        const unlock = document.getElementById('unlock-screen');
                        if (unlock) unlock.hidden = true;
                      }
                      return probe;
                    }""",
                    PASSWORD,
                )
                page.wait_for_timeout(3000)

            locked_at = None
            sample_every = 15
            steps = max(1, IDLE_SEC // sample_every)
            for step in range(1, steps + 1):
                time.sleep(sample_every)
                snap = page.evaluate(
                    """() => ({
                      unlocked: document.body.classList.contains('unlocked'),
                      unlockVisible: !!(document.getElementById('unlock-screen')
                        && !document.getElementById('unlock-screen').hidden),
                      hasKey: !!NotesStore.state?.cryptoKey,
                      verified: !!NotesStore.state?.keyVerified,
                      notes: NotesStore.listNotes ? NotesStore.listNotes().length : 0,
                      err: document.getElementById('unlock-error')?.textContent || '',
                      visibility: document.visibilityState,
                      unfocusedAt: localStorage.getItem('notes_unfocused_at') || '',
                    })"""
                )
                print(f"TRIAL{trial}+{step * sample_every}s", json.dumps(snap))
                if snap.get("unlockVisible") and not snap.get("unlocked"):
                    locked_at = step * sample_every
                    break
                if not snap.get("hasKey") and snap.get("unlockVisible"):
                    locked_at = step * sample_every
                    break

            lock_logs = [c for c in console if "[notes-lock]" in c or "Locked after" in c]
            results.append({
                "trial": trial,
                "locked_at": locked_at,
                "build": state.get("build"),
                "lock_logs": lock_logs[-10:],
            })

            page.evaluate(
                """async () => {
                  try { await NotesStore.clearDeviceData(); } catch (e) {}
                  try {
                    const csrf = NotesStore.csrf?.() || '';
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
            context.close()

        browser.close()

    print("RESULTS", json.dumps(results, indent=2))
    failed = [r for r in results if r.get("locked_at") is not None]
    if failed:
        print("E2E_FAIL vault locked while tab stayed visible", file=sys.stderr)
        return 1
    print("E2E_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
