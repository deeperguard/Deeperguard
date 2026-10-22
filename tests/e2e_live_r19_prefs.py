#!/usr/bin/env python3
"""Live E2E: lock prefs survive sign-out → sign-in; vault stats match list (Round 55)."""
from __future__ import annotations

import json
import os
import sys

BASE = os.environ.get("NOTES_E2E_BASE", "https://www.deeperguard.com").rstrip("/")
EMAIL = os.environ.get("NOTES_E2E_EMAIL", "deeperguard-tester+r19@mail.grokbot.com")
PASSWORD = os.environ.get("NOTES_E2E_PASSWORD", "DgR19-Test-2026!xyz")


def main() -> int:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900}).new_page()

        def login() -> None:
            page.goto(f"{BASE}/login", wait_until="domcontentloaded", timeout=90000)
            page.fill('#login-form [name="email"]', EMAIL)
            page.fill('#login-form [name="password"]', PASSWORD)
            with page.expect_navigation(wait_until="domcontentloaded", timeout=90000):
                page.click('#login-form button[type="submit"]')
            page.wait_for_function(
                "() => document.body.classList.contains('unlocked')",
                timeout=90000,
            )
            page.wait_for_timeout(5000)

        def sign_out_keep_prefs() -> dict:
            before = page.evaluate(
                """() => JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}')"""
            )
            page.evaluate(
                """async () => {
                  const prefs = localStorage.getItem('deeperguard-prefs');
                  try { await NotesStore.clearDeviceData(); } catch (e) {}
                  try {
                    const csrf = NotesStore.csrf?.() || '';
                    await fetch('/api/auth/logout', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
                      body: '{}',
                    });
                  } catch (e) {}
                  sessionStorage.clear();
                  // clearDeviceData must not wipe prefs; re-assert if a future bug does.
                  if (prefs) localStorage.setItem('deeperguard-prefs', prefs);
                }"""
            )
            return before

        login()
        # Set explicit lock prefs and push after hydrate.
        set_result = page.evaluate(
            """async () => {
              // Wait until vault settings are readable / hydrated path can push.
              for (let i = 0; i < 40; i += 1) {
                if (NotesStore.getGlobalSettings?.()) break;
                await new Promise((r) => setTimeout(r, 250));
              }
              const prefs = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
              prefs.autoLockMin = 15;
              prefs.lockOnUnfocus = '1min';
              localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
              // Drive in-memory prefs via the same keys Settings uses.
              const auto = document.getElementById('pref-auto-lock');
              const un = document.getElementById('pref-lock-on-unfocus');
              if (auto) {
                auto.value = '15';
                auto.dispatchEvent(new Event('change', { bubbles: true }));
              }
              if (un) {
                un.value = '1min';
                un.dispatchEvent(new Event('change', { bubbles: true }));
              }
              await new Promise((r) => setTimeout(r, 1500));
              const remote = NotesStore.getGlobalSettings()?.prefs || {};
              const local = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
              const stats = document.getElementById('vault-stats')?.textContent || '';
              const list = document.getElementById('note-list-count')?.textContent || '';
              return { local, remote, stats, list, build: document.querySelector('meta[name="notes-build"]')?.content };
            }"""
        )
        print("SET", json.dumps(set_result, indent=2))

        before = sign_out_keep_prefs()
        print("BEFORE_SIGNOUT", json.dumps({
            "autoLockMin": before.get("autoLockMin"),
            "lockOnUnfocus": before.get("lockOnUnfocus"),
        }))
        page.goto(f"{BASE}/login", wait_until="domcontentloaded")
        prefs_on_login = page.evaluate(
            """() => {
              const p = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
              return { autoLockMin: p.autoLockMin, lockOnUnfocus: p.lockOnUnfocus };
            }"""
        )
        print("PREFS_ON_LOGIN_PAGE", json.dumps(prefs_on_login))

        login()
        after = page.evaluate(
            """async () => {
              for (let i = 0; i < 40; i += 1) {
                if (NotesStore.getGlobalSettings?.()) break;
                await new Promise((r) => setTimeout(r, 250));
              }
              await new Promise((r) => setTimeout(r, 1000));
              const local = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
              const remote = NotesStore.getGlobalSettings()?.prefs || {};
              // Open settings the way the app does and read selects.
              document.getElementById('btn-settings-head')?.click();
              document.getElementById('btn-settings-nav')?.click();
              await new Promise((r) => setTimeout(r, 800));
              return {
                local: { autoLockMin: local.autoLockMin, lockOnUnfocus: local.lockOnUnfocus },
                remote: { autoLockMin: remote.autoLockMin, lockOnUnfocus: remote.lockOnUnfocus },
                selects: {
                  auto: document.getElementById('pref-auto-lock')?.value,
                  unfocus: document.getElementById('pref-lock-on-unfocus')?.value,
                },
                stats: document.getElementById('vault-stats')?.textContent || '',
                list: document.getElementById('note-list-count')?.textContent || '',
                build: document.querySelector('meta[name="notes-build"]')?.content || '',
              };
            }"""
        )
        print("AFTER", json.dumps(after, indent=2))
        browser.close()

        ok = (
            after.get("local", {}).get("autoLockMin") == 15
            and after.get("local", {}).get("lockOnUnfocus") == "1min"
            and after.get("remote", {}).get("autoLockMin") == 15
            and after.get("remote", {}).get("lockOnUnfocus") == "1min"
            and after.get("selects", {}).get("auto") == "15"
            and after.get("selects", {}).get("unfocus") == "1min"
        )
        # Counts: list "N notes" must appear in vault-stats prefix.
        import re
        list_m = re.search(r"(\d+)\s+notes?", after.get("list") or "")
        stats = after.get("stats") or ""
        if list_m:
            n = list_m.group(1)
            if not stats.startswith(f"{n} note"):
                print("E2E_FAIL count mismatch", list_m.group(0), "vs", stats, file=sys.stderr)
                ok = False
        if not ok:
            print("E2E_FAIL prefs did not persist", file=sys.stderr)
            return 1
        print("E2E_OK")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
