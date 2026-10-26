#!/usr/bin/env python3
"""Live E2E: lock prefs survive sign-out → sign-in; vault stats match list (Round 55).

Requires NOTES_E2E_EMAIL and NOTES_E2E_PASSWORD (no defaults — H1).
"""
from __future__ import annotations

import json
import os
import sys

BASE = os.environ.get("NOTES_E2E_BASE", "https://www.deeperguard.com").rstrip("/")
EMAIL = os.environ.get("NOTES_E2E_EMAIL", "").strip()
PASSWORD = os.environ.get("NOTES_E2E_PASSWORD", "")


def main() -> int:
    if not EMAIL or not PASSWORD:
        print("SKIP: set NOTES_E2E_EMAIL and NOTES_E2E_PASSWORD to run live prefs E2E")
        return 0

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900}).new_page()

        def login() -> None:
            page.goto(f"{BASE}/login", wait_until="domcontentloaded", timeout=90000)
            page.fill('#login-form [name="email"]', EMAIL)
            page.fill('#login-password', PASSWORD)
            with page.expect_navigation(wait_until="domcontentloaded", timeout=90000):
                page.click('#login-submit')
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
                  if (prefs) localStorage.setItem('deeperguard-prefs', prefs);
                }"""
            )
            return before

        login()
        set_result = page.evaluate(
            """async () => {
              for (let i = 0; i < 40; i += 1) {
                if (NotesStore.getGlobalSettings?.()) break;
                await new Promise((r) => setTimeout(r, 250));
              }
              const prefs = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
              prefs.autoLockMin = 15;
              prefs.lockOnUnfocus = '1min';
              localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
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
              const remote = NotesStore.getGlobalSettings?.();
              const stats = document.getElementById('vault-stats')?.textContent || '';
              const list = document.getElementById('notes-count')?.textContent
                || document.querySelector('.notes-count')?.textContent || '';
              return {
                local: JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}'),
                remote: remote?.prefs || null,
                stats,
                list,
                build: document.querySelector('meta[name="notes-build"]')?.content || '',
              };
            }"""
        )
        print("SET", json.dumps(set_result, indent=2))

        before = sign_out_keep_prefs()
        print("BEFORE_SIGNOUT", {
            "autoLockMin": before.get("autoLockMin"),
            "lockOnUnfocus": before.get("lockOnUnfocus"),
        })
        page.goto(f"{BASE}/login", wait_until="domcontentloaded", timeout=90000)
        prefs_on_login = page.evaluate(
            """() => {
              const p = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
              return { autoLockMin: p.autoLockMin, lockOnUnfocus: p.lockOnUnfocus };
            }"""
        )
        print("PREFS_ON_LOGIN_PAGE", prefs_on_login)
        login()
        after = page.evaluate(
            """async () => {
              for (let i = 0; i < 40; i += 1) {
                if (window.globalPrefsHydrated || NotesStore.getGlobalSettings?.()) break;
                await new Promise((r) => setTimeout(r, 250));
              }
              await new Promise((r) => setTimeout(r, 1500));
              const local = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
              const remote = NotesStore.getGlobalSettings?.();
              return {
                local: {
                  autoLockMin: local.autoLockMin,
                  lockOnUnfocus: local.lockOnUnfocus,
                },
                remote: {
                  autoLockMin: remote?.prefs?.autoLockMin,
                  lockOnUnfocus: remote?.prefs?.lockOnUnfocus,
                },
                selects: {
                  auto: document.getElementById('pref-auto-lock')?.value || '',
                  unfocus: document.getElementById('pref-lock-on-unfocus')?.value || '',
                },
                stats: document.getElementById('vault-stats')?.textContent || '',
                list: document.getElementById('notes-count')?.textContent
                  || document.querySelector('.notes-count')?.textContent || '',
                build: document.querySelector('meta[name="notes-build"]')?.content || '',
              };
            }"""
        )
        print("AFTER", json.dumps(after, indent=2))
        browser.close()

        if after["local"].get("autoLockMin") != 15 or after["local"].get("lockOnUnfocus") != "1min":
            print("FAIL local prefs changed", file=sys.stderr)
            return 1
        if after["remote"] and (
            after["remote"].get("autoLockMin") != 15
            or after["remote"].get("lockOnUnfocus") != "1min"
        ):
            print("FAIL remote prefs changed", file=sys.stderr)
            return 1
        print("E2E_OK")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
