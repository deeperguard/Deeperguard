#!/usr/bin/env python3
"""Agenda UI captures: one synthetic account, dismiss toasts, light/dark (PR A/B)."""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ART = Path("/opt/cursor/artifacts")
ART.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(ROOT / "tests"))
from run_agenda_view_matrix import (  # noqa: E402
    ANCHOR_MON,
    SEED_FIXTURE,
    free_port,
    start_server,
)

DISMISS_CHROME = """
() => {
  const t = document.getElementById('toast');
  if (t) { t.hidden = true; t.textContent = ''; t.classList.remove('error'); }
  document.documentElement.classList.remove('totp-toast-open');
  document.querySelectorAll(
    '.verify-banner, #verify-email-banner, .dg-toast, .toast, [role="status"][class*="toast"]',
  ).forEach((el) => {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
  });
}
"""

WAIT_APP = """
() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()
"""

UNLOCK_IF_NEEDED = """
async (password) => {
  if (NotesStore.isUnlocked()) return true;
  let salt = null;
  try { salt = sessionStorage.getItem('notes_salt'); } catch (e) {}
  if (!salt) {
    try { salt = localStorage.getItem('notes_salt'); } catch (e) {}
  }
  if (!salt && NotesStore.state?.account?.kdf_salt) {
    salt = NotesStore.state.account.kdf_salt;
  }
  await NotesStore.unlock(password, salt);
  NotesStore.markKeyVerified?.();
  return NotesStore.isUnlocked();
}
"""


GO_AGENDA_TAB = """
() => {
  const btn = document.getElementById('app-tab-agenda');
  if (btn) btn.click();
}
"""


SET_THEME = """
(theme) => {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.colorScheme = t;
  if (document.body) document.body.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#0f1419');
  try {
    const raw = localStorage.getItem('deeperguard-prefs') || '{}';
    const p = JSON.parse(raw);
    p.theme = t;
    localStorage.setItem('deeperguard-prefs', JSON.stringify(p));
  } catch (e) { /* ignore */ }
}
"""

RE_RENDER = """
() => {
  if (window.NotesAgenda?.render) NotesAgenda.render();
}
"""

PR_B_SEED = """
() => {
  const mon = new Date();
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  mon.setHours(0, 0, 0, 0);
  const wed = new Date(mon);
  wed.setDate(wed.getDate() + 2);
  const mk = (title, start, end, extra) => {
    const id = NotesStore.newUuid();
    const body = {
      title, start: start.toISOString(), end: end.toISOString(),
      all_day: !!extra?.all_day, location: extra?.location || '',
    };
    if (extra?.rrule) body.rrule = extra.rrule;
    NotesStore.upsertAgendaEvent(id, body);
    return id;
  };
  mk('Solo full width', new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 15, 0),
     new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 16, 0), { location: 'Room A' });
  mk('Overlap A', new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 10, 0),
     new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 11, 30), {});
  mk('Overlap B', new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 10, 30),
     new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 11, 0), {});
  mk('Short repeat', new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 13, 0),
     new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 13, 30),
     { rrule: 'FREQ=WEEKLY;INTERVAL=1' });
  const thu = new Date(mon);
  thu.setDate(thu.getDate() + 3);
  mk('All-day pack 1', thu, new Date(thu.getTime() + 86400000), { all_day: true });
  const fri = new Date(mon);
  fri.setDate(fri.getDate() + 4);
  mk('All-day pack 2', fri, new Date(fri.getTime() + 86400000), { all_day: true });
  return NotesStore.flush().then(() => ({ monMs: mon.getTime(), wedMs: wed.getTime() }));
}
"""

VIEWPORTS = (
    ("390", 390, 844),
    ("428", 428, 926),
    ("1280", 1280, 800),
)


def ensure_session(page, base: str, email: str, password: str, *, registered: bool) -> None:
    if registered:
        page.goto(f"{base}/login", wait_until="domcontentloaded")
        page.fill('#login-form [name="email"]', email)
        page.fill("#login-password", password)
        page.click("#login-submit")
    else:
        page.goto(f"{base}/register", wait_until="domcontentloaded")
        page.fill('input[name="email"]', email)
        page.fill("#register-password", password)
        page.fill("#register-password2", password)
        page.check("#register-terms")
        page.check("#register-recover-ack")
        page.click("#register-submit")
    page.wait_for_function(WAIT_APP, timeout=240_000)
    page.evaluate("() => NotesStore.markKeyVerified?.()")
    page.evaluate(DISMISS_CHROME)


PICK_VIEW = """
(view) => {
  if (document.getElementById('agenda-phone-more')) {
    document.body.classList.remove('agenda-phone-menu-open');
    const b = document.getElementById('agenda-phone-menu-backdrop');
    if (b) b.hidden = true;
    document.getElementById('agenda-phone-more')?.click();
    document.querySelector(`#agenda-phone-menu [data-agenda-view="${view}"]`)?.click();
    document.body.classList.remove('agenda-phone-menu-open');
    if (b) b.hidden = true;
  } else {
    document.querySelector(`[data-agenda-view="${view}"]`)?.click();
  }
}
"""


def capture(
    page,
    name: str,
    theme: str,
    *,
    open_menu: bool = False,
) -> None:
    scheme = "light" if theme == "light" else "dark"
    page.emulate_media(color_scheme=scheme)
    page.evaluate(DISMISS_CHROME)
    page.evaluate(SET_THEME, scheme)
    page.wait_for_timeout(350)
    if open_menu:
        page.evaluate("() => document.getElementById('agenda-phone-more')?.click()")
        page.wait_for_timeout(250)
    else:
        page.evaluate(
            "() => { document.body.classList.remove('agenda-phone-menu-open'); "
            "const b = document.getElementById('agenda-phone-menu-backdrop'); if (b) b.hidden = true; }"
        )
    page.evaluate(DISMISS_CHROME)
    page.locator("#agenda-pane").screenshot(path=str(ART / name))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr", choices=("a", "b", "e"), default="a")
    args = parser.parse_args()
    pr = args.pr

    from playwright.sync_api import sync_playwright

    data = Path(tempfile.mkdtemp(prefix="dg-agenda-cap-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(data, port)
    email = "agenda-capture@e2e.invalid"
    password = "CapturePass1!abc"
    paths: list[str] = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
            page = ctx.new_page()
            ensure_session(page, base, email, password, registered=False)
            seed = PR_B_SEED if pr == "b" else SEED_FIXTURE
            fx = page.evaluate(seed)
            page.evaluate(GO_AGENDA_TAB)
            page.wait_for_selector("#agenda-pane", state="attached", timeout=30_000)
            page.wait_for_selector("#agenda-root .agenda-body", state="attached", timeout=30_000)

            if pr == "e":
                page.evaluate("() => NotesAgendaReminders?.wireAgendaReminderSettings?.()")
                for theme in ("light", "dark"):
                    for vp_name, w, h in (("390", 390, 844), ("1280", 1280, 800)):
                        page.set_viewport_size({"width": w, "height": h})
                        page.evaluate(DISMISS_CHROME)
                        page.evaluate(RE_RENDER)
                        page.evaluate(
                            "() => document.getElementById('agenda-calendar-settings-btn')?.click()",
                        )
                        page.wait_for_timeout(400)
                        shot = f"agenda-pr-e-{theme}-reminders-{vp_name}x{h}.png"
                        capture(page, shot, theme)
                        paths.append(shot)
                        page.evaluate(
                            "() => document.getElementById('agenda-calendar-settings-close')?.click()",
                        )
                        page.wait_for_timeout(200)
            for theme in ("light", "dark"):
                if pr == "e":
                    continue
                for vp_name, w, h in VIEWPORTS:
                    desktop = w >= 900
                    page.set_viewport_size({"width": w, "height": h})
                    page.evaluate(DISMISS_CHROME)
                    page.evaluate(RE_RENDER)

                    if pr == "a":
                        if desktop:
                            page.click('[data-agenda-view="week"]')
                        else:
                            page.evaluate(PICK_VIEW, "month")
                        page.evaluate(RE_RENDER)
                        page.wait_for_timeout(400)
                        tag = f"agenda-pr-a-{theme}-{vp_name}x{h}"
                        capture(page, f"{tag}.png", theme, open_menu=False)
                        paths.append(f"{tag}.png")
                        if not desktop:
                            capture(page, f"{tag}-menu-open.png", theme, open_menu=True)
                            paths.append(f"{tag}-menu-open.png")
                    else:
                        if desktop:
                            page.click('[data-agenda-view="week"]')
                            page.evaluate(ANCHOR_MON, fx)
                        else:
                            page.evaluate(PICK_VIEW, "agenda")
                        page.evaluate(RE_RENDER)
                        page.wait_for_timeout(500)
                        suffix = "list" if not desktop else "week"
                        tag = f"agenda-pr-b-{theme}-{suffix}-{vp_name}x{h}"
                        capture(page, f"{tag}.png", theme)
                        paths.append(f"{tag}.png")
                        if desktop:
                            tag2 = f"agenda-pr-b-{theme}-week-polish-{vp_name}x{h}"
                            page.locator(".agenda-week-layout").screenshot(path=str(ART / f"{tag2}.png"))
                            paths.append(f"{tag2}.png")
                            page.click('[data-agenda-view="agenda"]')
                            page.evaluate(RE_RENDER)
                            page.wait_for_timeout(400)
                            tag3 = f"agenda-pr-b-{theme}-list-{vp_name}x{h}"
                            capture(page, f"{tag3}.png", theme)
                            paths.append(f"{tag3}.png")
            if pr == "b":
                page.evaluate(
                    """() => {
                      NotesStore.listAgendaEvents().forEach((e) => NotesStore.removeAgendaEvent(e.id));
                      return NotesStore.flush();
                    }""",
                )
                for vp_name, w, h in (("390", 390, 844), ("1280", 1280, 800)):
                    for theme in ("light", "dark"):
                        scheme = "light" if theme == "light" else "dark"
                        page.set_viewport_size({"width": w, "height": h})
                        page.emulate_media(color_scheme=scheme)
                        page.evaluate(SET_THEME, scheme)
                        page.evaluate(PICK_VIEW, "agenda")
                        page.evaluate(RE_RENDER)
                        page.wait_for_timeout(400)
                        tag = f"agenda-pr-b-empty-{theme}-list-{vp_name}x{h}.png"
                        capture(page, tag, theme)
                        paths.append(tag)
            ctx.close()
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=15)

    print(json.dumps({"pr": pr, "artifacts": paths, "dir": str(ART)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
