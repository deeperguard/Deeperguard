#!/usr/bin/env python3
"""
Agenda view matrix: DOM centering, period oracles, gestures. Local disposable free-plan fixtures.
Run: python3 tests/run_agenda_view_matrix.py
"""
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
ART = Path("/opt/cursor/artifacts/agenda-matrix-verify")
ART.mkdir(parents=True, exist_ok=True)

TIMED = ("week", "3day", "day")
ALL_VIEWS = ("week", "3day", "day", "month", "agenda")
VIEWPORTS = (("390", 390, 844), ("428", 428, 926), ("1280", 1280, 800))
CENTER_TOL = 36


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(root: Path, port: int):
    env = {
        **os.environ,
        "NOTES_ROOT": str(root),
        "NOTES_DATA": str(root / "data"),
        "NOTES_KEYS": str(root / "keys"),
        "NOTES_ALLOWED_CIDRS": "127.0.0.1/32",
        "NOTES_ALLOW_REGISTER": "1",
        "NOTES_DISABLE_CIDR_GATE": "1",
        "NOTES_STRICT_ZK": "1",
        "NOTES_SECURE_COOKIES": "0",
        "NOTES_DEFAULT_PLAN": "free",
        "FLASK_APP": "app",
        "PYTHONPATH": str(APP),
    }
    (root / "keys").mkdir(parents=True, exist_ok=True)
    (root / "keys" / "flask-secret").write_text("matrix-secret", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "flask", "run", "--host", "127.0.0.1", f"--port={port}"],
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


PERIOD_STATE = """
() => {
  const view = document.querySelector('.agenda-seg.is-active')?.getAttribute('data-agenda-view');
  const list = document.querySelector('.agenda-list-view');
  if (list) {
    return {
      view,
      rangeStart: list.getAttribute('data-agenda-range-start'),
      rangeEnd: list.getAttribute('data-agenda-range-end'),
    };
  }
  const month = document.querySelector('.agenda-month-grid');
  if (month) {
    return {
      view,
      rangeStart: month.getAttribute('data-agenda-range-start'),
      rangeEnd: month.getAttribute('data-agenda-range-end'),
    };
  }
  const cols = [...document.querySelectorAll('.agenda-day-col[data-agenda-day]')].map(
    (c) => c.getAttribute('data-agenda-day'),
  );
  return { view, dayCols: cols };
}
"""

MEASURE_EARLIEST = f"""
() => {{
  const wrap = document.querySelector('.agenda-scroll-wrap');
  if (!wrap) return {{ ok: false, reason: 'no-wrap' }};
  const head = document.querySelector('.agenda-col-head');
  const headH = head ? head.getBoundingClientRect().height : 0;
  const wRect = wrap.getBoundingClientRect();
  const portTop = wRect.top + headH;
  const portH = Math.max(0, wRect.height - headH);
  const portCenter = portTop + portH / 2;
  const chips = [...document.querySelectorAll('.agenda-event-chip')].filter(
    (el) => !el.classList.contains('agenda-allday-chip'),
  );
  if (!chips.length) return {{ ok: false, reason: 'no-timed-chips', scrollTop: wrap.scrollTop }};
  let best = chips[0];
  let bestTop = best.getBoundingClientRect().top;
  for (const el of chips) {{
    const t = el.getBoundingClientRect().top;
    if (t < bestTop) {{ best = el; bestTop = t; }}
  }}
  const r = best.getBoundingClientRect();
  const cy = r.top + r.height / 2;
  const diff = Math.abs(cy - portCenter);
  const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
  const clamped = wrap.scrollTop >= 0 && wrap.scrollTop <= maxTop + 1;
  return {{
    ok: diff < {CENTER_TOL} && clamped,
    diff,
    clamped,
    scrollTop: wrap.scrollTop,
    maxTop,
    title: best.querySelector('.agenda-chip-title')?.textContent?.trim(),
  }};
}}
"""

SEED_FIXTURE = """
() => {
  const mon = new Date();
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  mon.setHours(14, 0, 0, 0);
  const wed = new Date(mon);
  wed.setDate(wed.getDate() + 2);
  wed.setHours(8, 0, 0, 0);
  const nmon = new Date(mon);
  nmon.setDate(nmon.getDate() + 7);
  nmon.setHours(10, 0, 0, 0);
  const wd = new Date(wed);
  wd.setHours(0, 0, 0, 0);
  const mn = new Date(mon);
  mn.setHours(0, 0, 0, 0);
  NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
    title: 'Audit Mon 14:00', start: mon.toISOString(),
    end: new Date(mon.getTime() + 3600000).toISOString(), all_day: false, ical_uid: 'mx-mon',
  });
  NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
    title: 'Audit Wed 08:00', start: wed.toISOString(),
    end: new Date(wed.getTime() + 3600000).toISOString(), all_day: false, ical_uid: 'mx-wed',
  });
  NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
    title: 'Audit NextMon 10:00', start: nmon.toISOString(),
    end: new Date(nmon.getTime() + 3600000).toISOString(), all_day: false, ical_uid: 'mx-nmon',
  });
  return NotesStore.flush().then(() => ({ monMs: mn.getTime(), wedMs: wd.getTime() }));
}
"""

ANCHOR_MON = """
({ monMs }) => {
  const cols = () => document.querySelector('.agenda-day-col[data-agenda-day]');
  const cur = () => (cols() ? Number(cols().getAttribute('data-agenda-day')) : NaN);
  const prev = document.getElementById('agenda-prev');
  const next = document.getElementById('agenda-next');
  let n = 0;
  while (n++ < 24 && cols() && cur() !== monMs) {
    if (cur() > monMs) prev?.click(); else next?.click();
  }
  return cur();
}
"""

GOTO_DAY_WED = """
({ wedMs }) => {
  const col = () => document.querySelector('.agenda-day-col[data-agenda-day]');
  const prev = document.getElementById('agenda-prev');
  const next = document.getElementById('agenda-next');
  let n = 0;
  while (n++ < 24 && col() && Number(col().getAttribute('data-agenda-day')) !== wedMs) {
    const c = Number(col().getAttribute('data-agenda-day'));
    if (c > wedMs) prev?.click(); else next?.click();
  }
  return col()?.getAttribute('data-agenda-day');
}
"""

TOUCH_SWIPE = """
([dir, sel]) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const yy = r.top + r.height * 0.5;
  const x0 = dir === 'left' ? r.left + r.width * 0.78 : r.left + r.width * 0.22;
  const x1 = dir === 'left' ? r.left + r.width * 0.22 : r.left + r.width * 0.78;
  const mk = (type, x, touches) => {
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: yy });
    el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: touches ? [t] : [], changedTouches: [t] }));
  };
  mk('touchstart', x0, true);
  for (let i = 1; i <= 6; i++) mk('touchmove', x0 + (x1 - x0) * (i / 6), true);
  mk('touchend', x1, false);
  return true;
}
"""


def mouse_swipe(page, selector: str, direction: str) -> None:
    box = page.locator(selector).first.bounding_box()
    if not box:
        return
    y = box["y"] + box["height"] * 0.5
    if direction == "left":
        x0, x1 = box["x"] + box["width"] * 0.78, box["x"] + box["width"] * 0.22
    else:
        x0, x1 = box["x"] + box["width"] * 0.22, box["x"] + box["width"] * 0.78
    page.mouse.move(x0, y)
    page.mouse.down()
    page.mouse.move(x1, y, steps=12)
    page.mouse.up()


def horiz(page, desktop: bool, direction: str, selector: str = ".agenda-body") -> None:
    if desktop:
        mouse_swipe(page, selector, direction)
    else:
        page.evaluate(TOUCH_SWIPE, [direction, selector])
    page.wait_for_timeout(450)


def main() -> int:
    from playwright.sync_api import sync_playwright

    data = Path(tempfile.mkdtemp(prefix="dg-matrix-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(data, port)
    results: list[dict] = []
    shots = 0

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for vp_name, w, h in VIEWPORTS:
                desktop = w >= 900
                ctx = browser.new_context(
                    viewport={"width": w, "height": h},
                    has_touch=True,
                    is_mobile=not desktop,
                )
                page = ctx.new_page()
                page.goto(f"{base}/register", wait_until="domcontentloaded")
                email = f"matrix-{vp_name}@e2e.invalid"
                pw = "MatrixPass1!abc"
                page.fill('input[name="email"]', email)
                page.fill("#register-password", pw)
                page.fill("#register-password2", pw)
                page.check("#register-terms")
                page.check("#register-recover-ack")
                page.click("#register-submit")
                page.wait_for_function(
                    "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()",
                    timeout=120_000,
                )
                page.evaluate("() => NotesStore.markKeyVerified?.()")
                fx = page.evaluate(SEED_FIXTURE)
                page.click("#app-tab-agenda")
                page.wait_for_selector(".agenda-scroll-wrap", timeout=30_000)
                page.click('[data-agenda-view="week"]')
                page.wait_for_timeout(300)
                page.evaluate(ANCHOR_MON, fx)
                page.wait_for_timeout(400)

                for view in ALL_VIEWS:
                    page.evaluate("() => { try { sessionStorage.clear(); } catch (e) {} }")
                    page.fill("#agenda-search", "")
                    page.wait_for_timeout(100)
                    page.click(f'[data-agenda-view="{view}"]')
                    if view == "day":
                        page.evaluate(GOTO_DAY_WED, fx)
                    elif view in ("week", "3day"):
                        page.evaluate(ANCHOR_MON, fx)
                    page.wait_for_timeout(700)

                    if view in TIMED:
                        m = page.evaluate(MEASURE_EARLIEST)
                        results.append(
                            {
                                "vp": vp_name,
                                "view": view,
                                "check": "dom_center_earliest",
                                "ok": bool(m.get("ok")),
                                "detail": m,
                            }
                        )

                    p0 = page.evaluate(PERIOD_STATE)
                    horiz(page, desktop, "left")
                    pL = page.evaluate(PERIOD_STATE)
                    results.append(
                        {
                            "vp": vp_name,
                            "view": view,
                            "check": "period_swipe_left",
                            "ok": json.dumps(p0, sort_keys=True) != json.dumps(pL, sort_keys=True),
                            "detail": {"before": p0, "after": pL},
                        }
                    )
                    horiz(page, desktop, "right")
                    pR = page.evaluate(PERIOD_STATE)
                    results.append(
                        {
                            "vp": vp_name,
                            "view": view,
                            "check": "period_swipe_right",
                            "ok": json.dumps(pL, sort_keys=True) != json.dumps(pR, sort_keys=True),
                            "detail": {"before": pL, "after": pR},
                        }
                    )

                    pb = page.evaluate(PERIOD_STATE)
                    if desktop:
                        box = page.locator(".agenda-body").bounding_box()
                        if box:
                            x = box["x"] + box["width"] / 2
                            page.mouse.move(x, box["y"] + 40)
                            page.mouse.down()
                            page.mouse.move(x, box["y"] + box["height"] * 0.9, steps=12)
                            page.mouse.up()
                    else:
                        page.evaluate(
                            """() => {
                          const el = document.querySelector('.agenda-body');
                          const r = el.getBoundingClientRect();
                          const x = r.left + r.width / 2;
                          const mk = (type, yy, touches) => {
                            const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: yy });
                            el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
                              touches: touches ? [t] : [], changedTouches: [t] }));
                          };
                          mk('touchstart', r.top + 50, true);
                          mk('touchmove', r.top + r.height * 0.85, true);
                          mk('touchend', r.top + r.height * 0.85, false);
                        }"""
                        )
                    page.wait_for_timeout(350)
                    pv = page.evaluate(PERIOD_STATE)
                    results.append(
                        {
                            "vp": vp_name,
                            "view": view,
                            "check": "vertical_no_period",
                            "ok": json.dumps(pb, sort_keys=True) == json.dumps(pv, sort_keys=True),
                            "detail": {"before": pb, "after": pv},
                        }
                    )

                    if view in TIMED:
                        st0 = page.evaluate(
                            "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop"
                        )
                        page.fill("#agenda-search", "Audit")
                        page.wait_for_timeout(450)
                        st1 = page.evaluate(
                            "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop"
                        )
                        results.append(
                            {
                                "vp": vp_name,
                                "view": view,
                                "check": "search_no_jump",
                                "ok": st0 == st1,
                                "detail": {"before": st0, "after": st1},
                            }
                        )
                        page.fill("#agenda-search", "")
                        page.wait_for_timeout(200)
                        st2 = page.evaluate(
                            "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop"
                        )
                        page.click('[data-agenda-view="month"]')
                        page.wait_for_timeout(350)
                        page.click(f'[data-agenda-view="{view}"]')
                        if view == "day":
                            page.evaluate(GOTO_DAY_WED, fx)
                        else:
                            page.evaluate(ANCHOR_MON, fx)
                        page.wait_for_timeout(750)
                        st3 = page.evaluate(
                            "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop"
                        )
                        results.append(
                            {
                                "vp": vp_name,
                                "view": view,
                                "check": "manual_scroll_after_view_hop",
                                "ok": abs(st3 - st2) < 3,
                                "detail": {"saved": st2, "restored": st3},
                            }
                        )
                        page.evaluate(
                            """() => {
                          const w = document.querySelector('.agenda-scroll-wrap');
                          if (w) w.scrollTop = Math.min(w.scrollTop + 60, w.scrollHeight);
                        }"""
                        )
                        page.wait_for_timeout(120)
                        manual = page.evaluate(
                            "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop"
                        )
                        page.click('[data-agenda-view="month"]')
                        page.wait_for_timeout(250)
                        page.click(f'[data-agenda-view="{view}"]')
                        if view == "day":
                            page.evaluate(GOTO_DAY_WED, fx)
                        else:
                            page.evaluate(ANCHOR_MON, fx)
                        page.wait_for_timeout(750)
                        back = page.evaluate(
                            "() => document.querySelector('.agenda-scroll-wrap')?.scrollTop"
                        )
                        results.append(
                            {
                                "vp": vp_name,
                                "view": view,
                                "check": "manual_scroll_persisted",
                                "ok": abs(back - manual) < 4,
                                "detail": {"manual": manual, "after_return": back},
                            }
                        )

                    pa = page.evaluate(PERIOD_STATE)
                    horiz(page, desktop, "left", "#agenda-search")
                    pb2 = page.evaluate(PERIOD_STATE)
                    results.append(
                        {
                            "vp": vp_name,
                            "view": view,
                            "check": "search_input_blocks_nav",
                            "ok": json.dumps(pa, sort_keys=True) == json.dumps(pb2, sort_keys=True),
                            "detail": {"before": pa, "after": pb2},
                        }
                    )

                    if shots < 3 and view == "week" and vp_name == "428":
                        page.evaluate(ANCHOR_MON, fx)
                        page.click('[data-agenda-view="week"]')
                        page.wait_for_timeout(600)
                        page.locator("#agenda-pane").screenshot(
                            path=str(ART / f"scrubbed_center_week_{vp_name}.png")
                        )
                        shots += 1
                    if shots < 3 and view == "day" and vp_name == "390":
                        page.click(f'[data-agenda-view="day"]')
                        page.evaluate(GOTO_DAY_WED, fx)
                        page.wait_for_timeout(600)
                        page.locator("#agenda-pane").screenshot(
                            path=str(ART / f"scrubbed_center_day_{vp_name}.png")
                        )
                        shots += 1
                    if shots < 3 and view == "3day" and vp_name == "1280":
                        page.click('[data-agenda-view="3day"]')
                        page.evaluate(ANCHOR_MON, fx)
                        page.wait_for_timeout(600)
                        page.locator("#agenda-pane").screenshot(
                            path=str(ART / f"scrubbed_center_3day_{vp_name}.png")
                        )
                        shots += 1

                ctx.close()
            browser.close()
    finally:
        proc.terminate()

    for r in results:
        if "ok" not in r:
            r["ok"] = bool(r.get("ok"))
    failed = [r for r in results if not r.get("ok")]
    out = {"total": len(results), "failed": len(failed), "results": results}
    (ART / "matrix_results.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({"total": out["total"], "failed": out["failed"]}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
