#!/usr/bin/env python3
"""Local Playwright checks for Agenda centering + period nav (not in CI)."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(root: Path, port: int):
    env = dict(os.environ)
    env.update(
        {
            "NOTES_ROOT": str(root),
            "NOTES_DATA": str(root / "data"),
            "NOTES_KEYS": str(root / "keys"),
            "NOTES_ALLOWED_CIDRS": "127.0.0.1/32",
            "NOTES_SKIP_LOGIN": "0",
            "NOTES_ALLOW_REGISTER": "1",
            "NOTES_DISABLE_CIDR_GATE": "1",
            "NOTES_STRICT_ZK": "1",
            "NOTES_SECURE_COOKIES": "0",
            "NOTES_DEFAULT_PLAN": "free",
            "FLASK_APP": "app",
            "PYTHONPATH": str(APP),
        }
    )
    (root / "keys").mkdir(parents=True, exist_ok=True)
    (root / "keys" / "flask-secret").write_text("agenda-browser-secret", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "flask", "run", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(APP),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(80):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return proc
        except OSError:
            time.sleep(0.25)
    raise RuntimeError("flask did not start")


def main() -> int:
    from playwright.sync_api import sync_playwright

    viewports = [
        ("390", 390, 844),
        ("428", 428, 926),
        ("1280", 1280, 800),
    ]
    data = Path(tempfile.mkdtemp(prefix="dg-agenda-br-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(data, port)
    results: list[dict] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for name, w, h in viewports:
                ctx = browser.new_context(
                    viewport={"width": w, "height": h},
                    has_touch=True,
                    is_mobile=(w < 900),
                )
                page = ctx.new_page()
                page.goto(f"{base}/register", wait_until="domcontentloaded")
                email = f"agenda-br-{name}@e2e.invalid"
                pw = "agenda-browser-pass1"
                page.fill('input[name="email"]', email)
                page.fill("#register-password", pw)
                page.fill("#register-password2", pw)
                page.check("#register-terms")
                page.check("#register-recover-ack")
                page.click("#register-submit")
                page.wait_for_function("() => location.pathname === '/app'", timeout=120_000)
                page.wait_for_function(
                    "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked && NotesStore.isUnlocked()",
                    timeout=60_000,
                )
                page.evaluate(
                    """() => {
                      if (typeof NotesStore.markKeyVerified === 'function') NotesStore.markKeyVerified();
                    }"""
                )
                page.evaluate(
                    """() => {
                      const mon = new Date();
                      mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
                      mon.setHours(14, 0, 0, 0);
                      const wed = new Date(mon);
                      wed.setDate(wed.getDate() + 2);
                      wed.setHours(8, 0, 0, 0);
                      const e1 = NotesStore.newUuid();
                      const e2 = NotesStore.newUuid();
                      NotesStore.upsertAgendaEvent(e1, {
                        title: 'Audit Mon 14:00',
                        start: mon.toISOString(),
                        end: new Date(mon.getTime() + 3600000).toISOString(),
                        all_day: false,
                        ical_uid: 'br-mon',
                      });
                      NotesStore.upsertAgendaEvent(e2, {
                        title: 'Audit Wed 08:00',
                        start: wed.toISOString(),
                        end: new Date(wed.getTime() + 3600000).toISOString(),
                        all_day: false,
                        ical_uid: 'br-wed',
                      });
                      return NotesStore.flush();
                    }"""
                )
                page.click("#app-tab-agenda")
                page.wait_for_selector(".agenda-scroll-wrap", timeout=20_000)
                page.wait_for_timeout(600)
                geo = page.evaluate(
                    """() => {
                      const wrap = document.querySelector('.agenda-scroll-wrap');
                      const pxPerHour = 52;
                      const vh = wrap?.clientHeight || 0;
                      const eventTop = 8 * pxPerHour;
                      const target = Math.max(0, eventTop - vh / 2);
                      const top = wrap?.scrollTop ?? 0;
                      return { top, target, vh, diff: Math.abs(top - target) };
                    }"""
                )
                results.append(
                    {"vp": name, "check": "center_wed08", "ok": geo["diff"] < 80, "detail": geo}
                )
                dom_center = page.evaluate(
                    """() => {
                      const wrap = document.querySelector('.agenda-scroll-wrap');
                      const head = document.querySelector('.agenda-col-head');
                      const headH = head ? head.getBoundingClientRect().height : 0;
                      const wRect = wrap.getBoundingClientRect();
                      const portCenter = wRect.top + headH + Math.max(0, wRect.height - headH) / 2;
                      const chip = [...document.querySelectorAll('.agenda-event-chip')].find((el) =>
                        (el.querySelector('.agenda-chip-title')?.textContent || '').includes('Wed 08:00')
                      );
                      if (!chip) return { ok: false, reason: 'no-wed-chip' };
                      const r = chip.getBoundingClientRect();
                      const cy = r.top + r.height / 2;
                      const diff = Math.abs(cy - portCenter);
                      return { ok: diff < 32, diff, scrollTop: wrap.scrollTop, cy, portCenter };
                    }"""
                )
                results.append(
                    {
                        "vp": name,
                        "check": "dom_center_earliest_wed",
                        "ok": bool(dom_center.get("ok")),
                        "detail": dom_center,
                    }
                )
                before = page.evaluate(
                    "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop ?? 0"
                )
                page.fill("#agenda-search", "Mon")
                page.wait_for_timeout(500)
                after = page.evaluate(
                    "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop ?? 0"
                )
                results.append(
                    {
                        "vp": name,
                        "check": "search_no_jump",
                        "ok": before == after,
                        "detail": {"before": before, "after": after},
                    }
                )
                page.fill("#agenda-search", "")
                page.wait_for_timeout(300)
                page.click('[data-agenda-view="month"]')
                page.wait_for_timeout(500)
                title0 = page.locator(".agenda-title").inner_text()
                page.evaluate(
                    """() => {
                      const pane = document.getElementById('agenda-pane');
                      const el = pane || document.querySelector('.agenda-body');
                      if (!el) return;
                      const y = 320;
                      const x0 = 280;
                      const x1 = 80;
                      const mk = (type, x, touches) => {
                        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
                        const ts = touches ? [t] : [];
                        el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: ts, changedTouches: [t] }));
                      };
                      mk('touchstart', x0, true);
                      mk('touchmove', x1, true);
                      mk('touchend', x1, false);
                    }"""
                )
                page.wait_for_timeout(500)
                title1 = page.locator(".agenda-title").inner_text()
                results.append(
                    {
                        "vp": name,
                        "check": "month_swipe_period",
                        "ok": title0 != title1,
                        "detail": {"before": title0, "after": title1},
                    }
                )
                ctx.close()
            browser.close()
    finally:
        proc.terminate()
    out = {"results": results, "failed": sum(1 for r in results if not r.get("ok"))}
    print(json.dumps(out, indent=2))
    return 0 if out["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
