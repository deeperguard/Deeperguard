#!/usr/bin/env python3
"""Agenda editor: visibility, CRUD, recurrence, viewport at 390/428/1280."""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
ART = Path("/opt/cursor/artifacts/agenda-editor-verify")
ART.mkdir(parents=True, exist_ok=True)
VPS = (("390", 390, 844), ("428", 428, 926), ("1280", 1280, 800))


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
    (root / "keys" / "flask-secret").write_text("editor-br-secret", encoding="utf-8")
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


DATETIME_READABILITY_JS = """
() => {
  const start = document.getElementById('agenda-edit-start');
  const end = document.getElementById('agenda-edit-end');
  const alldayRow = document.querySelector('.agenda-editor-allday');
  const allday = document.getElementById('agenda-edit-allday');
  const field = start?.closest('.agenda-editor-datetime-field');
  const sr = start?.getBoundingClientRect();
  const fr = field?.getBoundingClientRect();
  const row = document.querySelector('.agenda-editor-datetime-row');
  const dialog = document.getElementById('agenda-editor');
  const rr = row?.getBoundingClientRect();
  const dw = dialog?.getBoundingClientRect().width || 0;
  const span = alldayRow?.querySelector('span');
  const spanBox = span?.getBoundingClientRect();
  const alldayBox = allday?.getBoundingClientRect();
  const sameRow = spanBox && alldayBox
    ? Math.abs(spanBox.top - alldayBox.top) < 10
    : false;
  const timePart = (v) => (v && v.includes('T') ? v.split('T')[1] : '');
  return {
    startValue: start?.value || '',
    endValue: end?.value || '',
    startTime: timePart(start?.value),
    endTime: timePart(end?.value),
    fieldWidth: fr?.width || 0,
    inputWidth: sr?.width || 0,
    rowWidth: rr?.width || 0,
    dialogWidth: dw,
    fieldInDialog: fr && dw ? fr.width >= dw * 0.62 : false,
    inputFillsField: fr && sr ? sr.width >= fr.width * 0.72 : false,
    alldayAligned: sameRow && !!alldayRow && alldayRow.contains(allday),
  };
}
"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    data = Path(tempfile.mkdtemp(prefix="dg-editor-"))
    port = free_port()
    proc = start_server(data, port)
    base = f"http://127.0.0.1:{port}"
    results: list[dict] = []
    shots = 0
    event_id_holder: dict = {}

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for vp_name, w, h in VPS:
                page = browser.new_page(viewport={"width": w, "height": h}, has_touch=w < 900)
                page.goto(f"{base}/register", wait_until="domcontentloaded")
                page.fill('input[name="email"]', f"editor-{vp_name}@e2e.invalid")
                pw = "EditorPass1!abc"
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
                fx = page.evaluate(
                    """async () => {
                  const start = new Date();
                  start.setHours(10, 30, 0, 0);
                  if (start.getTime() < Date.now()) start.setDate(start.getDate() + 1);
                  const id = NotesStore.newUuid();
                  NotesStore.upsertAgendaEvent(id, {
                    title: 'Editor test 10:30',
                    start: start.toISOString(),
                    end: new Date(start.getTime() + 3600000).toISOString(),
                    all_day: false,
                    rrule: 'FREQ=WEEKLY;INTERVAL=1;UNTIL=20261231T235959Z',
                    ical_uid: 'ed-weekly-' + id.slice(0, 8),
                  });
                  await NotesStore.flush();
                  if (typeof NotesAgenda !== 'undefined') NotesAgenda.render();
                  return { id, start: start.toISOString() };
                }"""
                )
                event_id_holder[vp_name] = fx["id"]
                page.click("#app-tab-agenda")
                page.wait_for_function(
                    "() => document.querySelector('#agenda-root [data-agenda-id]')",
                    timeout=30_000,
                )
                page.locator('[data-agenda-id]').first.click()
                page.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)
                focus = page.evaluate(
                    """() => ({
                      active: document.activeElement?.id || document.activeElement?.tagName,
                      seriesVisible: !document.getElementById('agenda-edit-series-notice')?.hidden,
                      titleVisible: !!document.getElementById('agenda-edit-title')?.offsetParent,
                    })"""
                )
                results.append(
                    {
                        "vp": vp_name,
                        "check": "keyboard_focus_series_notice",
                        "ok": focus.get("active") == "agenda-edit-title" and focus.get("seriesVisible"),
                        "detail": focus,
                    }
                )
                chrome = page.evaluate(
                    """() => {
                      function parseRgb(css) {
                        const m = String(css || '').match(/rgba?\\(([^)]+)\\)/);
                        if (!m) return null;
                        const p = m[1].split(',').map((x) => Number(x.trim()));
                        return p.length >= 3 ? { r: p[0], g: p[1], b: p[2] } : null;
                      }
                      function lin(c) {
                        const s = c / 255;
                        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                      }
                      function lum(rgb) {
                        if (!rgb) return 0;
                        return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
                      }
                      function contrast(f, b) {
                        const L1 = Math.max(lum(f), lum(b));
                        const L2 = Math.min(lum(f), lum(b));
                        return (L1 + 0.05) / (L2 + 0.05);
                      }
                      const banner = document.getElementById('agenda-edit-series-notice');
                      const status = document.getElementById('agenda-edit-rrule-status');
                      const sel = document.getElementById('agenda-edit-repeat');
                      const bSt = banner ? getComputedStyle(banner) : null;
                      const sSt = status ? getComputedStyle(status) : null;
                      const bFg = parseRgb(bSt?.color);
                      const bBg = parseRgb(bSt?.backgroundColor);
                      const sFg = parseRgb(sSt?.color);
                      const dialog = document.getElementById('agenda-editor');
                      const dBg = parseRgb(getComputedStyle(dialog).backgroundColor);
                      const sb = sel?.getBoundingClientRect();
                      return {
                        seriesContrast: contrast(bFg, bBg),
                        seriesColor: bSt?.color,
                        seriesBg: bSt?.backgroundColor,
                        helperContrast: contrast(sFg, dBg),
                        helperColor: sSt?.color,
                        dialogBg: getComputedStyle(dialog).backgroundColor,
                        patternSelectHeight: sb?.height,
                      };
                    }"""
                )
                results.append(
                    {
                        "vp": vp_name,
                        "check": "recurrence_contrast_and_pattern_height",
                        "ok": (chrome.get("seriesContrast") or 0) >= 4.5
                        and (chrome.get("helperContrast") or 0) >= 4.5
                        and 40 <= (chrome.get("patternSelectHeight") or 0) <= 48,
                        "detail": chrome,
                    }
                )
                page.locator("#agenda-editor").screenshot(
                    path=str(ART / f"editor_full_top_{vp_name}.png")
                )
                scroll = page.locator(".agenda-editor-scroll")
                scroll.evaluate("el => { el.scrollTop = el.scrollHeight; }")
                page.wait_for_timeout(250)
                save_vis = page.evaluate(
                    """() => {
                      const save = document.getElementById('agenda-edit-save');
                      const r = save?.getBoundingClientRect();
                      const vh = window.innerHeight;
                      return {
                        saveInView: !!(r && r.top >= 0 && r.bottom <= vh + 2),
                        scrollTop: document.querySelector('.agenda-editor-scroll')?.scrollTop,
                      };
                    }"""
                )
                page.locator("#agenda-editor").screenshot(
                    path=str(ART / f"editor_full_bottom_{vp_name}.png")
                )
                results.append(
                    {
                        "vp": vp_name,
                        "check": "sticky_actions_after_scroll",
                        "ok": save_vis.get("saveInView"),
                        "detail": save_vis,
                    }
                )
                scroll.evaluate("el => { el.scrollTop = 0; }")
                opened = page.evaluate(DATETIME_READABILITY_JS)
                time_ok = bool(
                    re.search(r"^10:30", opened.get("startTime") or "")
                    and re.search(r"^\d{2}:\d{2}", opened.get("endTime") or "")
                    and opened.get("fieldInDialog")
                    and opened.get("alldayAligned")
                )
                results.append(
                    {
                        "vp": vp_name,
                        "check": "datetime_readable_on_open",
                        "ok": time_ok,
                        "detail": opened,
                    }
                )
                if vp_name in ("390", "428") and shots < 3:
                    page.locator(".agenda-editor-datetime-row").screenshot(
                        path=str(ART / f"editor_datetime_{vp_name}.png")
                    )
                    shots += 1

                edit_start = page.evaluate(
                    """() => {
                  const el = document.getElementById('agenda-edit-start');
                  if (!el || !el.value) return null;
                  const [d] = el.value.split('T');
                  return `${d}T15:45`;
                }"""
                )
                assert edit_start, "start value missing for time edit"
                page.fill("#agenda-edit-start", edit_start)
                page.evaluate(
                    """() => {
                  const start = new Date(document.getElementById('agenda-edit-start').value);
                  const end = new Date(start.getTime() + 3600000);
                  const pad = (n) => String(n).padStart(2, '0');
                  const loc = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                  document.getElementById('agenda-edit-end').value = loc(end);
                }"""
                )
                page.fill("#agenda-edit-title", "Edited title 15:45")
                page.click("#agenda-edit-save")
                page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
                page.locator('[data-agenda-id]').first.click()
                page.wait_for_selector("#agenda-editor:not([hidden])")
                after_time = page.evaluate(DATETIME_READABILITY_JS)
                time_save_ok = (after_time.get("startTime") or "").startswith("15:45")
                results.append(
                    {
                        "vp": vp_name,
                        "check": "time_edit_save_reopen",
                        "ok": time_save_ok,
                        "detail": after_time,
                    }
                )

                page.fill("#agenda-edit-title", "Edited title")
                page.select_option("#agenda-edit-repeat", "biweekly")
                page.fill("#agenda-edit-until", "2026-12-31")
                page.click("#agenda-edit-save")
                page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
                page.locator('[data-agenda-id]').first.click()
                page.wait_for_selector("#agenda-editor:not([hidden])")
                reopened = page.evaluate(
                    """() => ({
                      title: document.getElementById('agenda-edit-title')?.value,
                      repeat: document.getElementById('agenda-edit-repeat')?.value,
                      noticeHidden: document.getElementById('agenda-edit-series-notice')?.hidden,
                    })"""
                )
                results.append(
                    {
                        "vp": vp_name,
                        "check": "save_reopen_recurrence",
                        "ok": reopened.get("title") == "Edited title"
                        and reopened.get("repeat") == "biweekly"
                        and reopened.get("noticeHidden") is False,
                        "detail": reopened,
                    }
                )
                page.fill("#agenda-edit-title", "Should not persist")
                page.click("#agenda-edit-cancel")
                page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
                page.locator('[data-agenda-id]').first.click()
                page.wait_for_selector("#agenda-editor:not([hidden])")
                cancel_ok = page.evaluate(
                    "() => document.getElementById('agenda-edit-title')?.value"
                )
                results.append(
                    {
                        "vp": vp_name,
                        "check": "cancel_discards_edits",
                        "ok": cancel_ok == "Edited title",
                        "detail": {"title": cancel_ok},
                    }
                )
                page.click("#agenda-edit-cancel")

                if vp_name == "428":
                    imp = page.evaluate(
                        """async () => {
                      const start = new Date();
                      start.setHours(11, 0, 0, 0);
                      if (start.getTime() < Date.now()) start.setDate(start.getDate() + 1);
                      const end = new Date(start.getTime() + 3600000);
                      const toIcsUtc = (d) => {
                        const pad = (n) => String(n).padStart(2, '0');
                        return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
                      };
                      const ex = new Date(start.getTime());
                      ex.setUTCDate(ex.getUTCDate() + 28);
                      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:exdate-browser-1
DTSTART:${toIcsUtc(start)}
DTEND:${toIcsUtc(end)}
SUMMARY:ICS EXDATE fixture
RRULE:FREQ=WEEKLY;INTERVAL=1
EXDATE:${toIcsUtc(ex)}
END:VEVENT
END:VCALENDAR`;
                      const { events } = NotesAgendaIcs.parseIcsFile(ics);
                      NotesStore.importAgendaFromIcs(events);
                      await NotesStore.flush();
                      NotesAgenda.render();
                      const row = NotesStore.listAgendaEvents().find((e) => e.ical_uid === 'exdate-browser-1');
                      return { id: row?.id, exdates: row?.ics_exdates || [], exIcs: toIcsUtc(ex) };
                    }"""
                    )
                    page.wait_for_function(
                        f"() => document.querySelector('[data-agenda-id=\"{imp['id']}\"]')",
                        timeout=15_000,
                    )
                    page.locator(f'[data-agenda-id="{imp["id"]}"]').click()
                    page.wait_for_selector("#agenda-editor:not([hidden])")
                    page.fill("#agenda-edit-title", "ICS EXDATE fixture (edited)")
                    page.click("#agenda-edit-save")
                    page.wait_for_selector("#agenda-editor", state="hidden")
                    ex = page.evaluate(
                        """(exIcs) => {
                      const rows = NotesStore.listAgendaEvents().filter((e) => e.ical_uid === 'exdate-browser-1');
                      const cal = NotesAgendaIcs.buildIcsCalendarFromEvents(rows);
                      const vault = rows[0] || {};
                      return {
                        vaultEx: vault.ics_exdates || [],
                        calHasExdate: cal.includes(`EXDATE:${exIcs}`),
                        rruleClean: (vault.rrule || '').indexOf('EXDATE') < 0,
                        exIcs,
                      };
                    }""",
                        imp["exIcs"],
                    )
                    results.append(
                        {
                            "vp": vp_name,
                            "check": "ics_exdate_import_edit_export",
                            "ok": ex.get("calHasExdate")
                            and ex.get("rruleClean")
                            and ex.get("vaultEx") == [imp["exIcs"]],
                            "detail": ex,
                        }
                    )

                page.locator("#agenda-add-event").click()
                page.wait_for_selector("#agenda-editor:not([hidden])")
                page.fill("#agenda-edit-title", "All day off")
                page.check("#agenda-edit-allday")
                page.wait_for_timeout(200)
                types = page.evaluate(
                    """() => ({
                      startType: document.getElementById('agenda-edit-start')?.type,
                      endType: document.getElementById('agenda-edit-end')?.type,
                    })"""
                )
                results.append(
                    {
                        "vp": vp_name,
                        "check": "allday_date_inputs",
                        "ok": types.get("startType") == "date" and types.get("endType") == "date",
                        "detail": types,
                    }
                )
                page.click("#agenda-edit-cancel")
                page.close()
            browser.close()
    finally:
        proc.terminate()

    failed = [r for r in results if not r.get("ok")]
    out = {"results": results, "failed": len(failed), "total": len(results)}
    (ART / "editor_results.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({"failed": out["failed"], "total": out["total"]}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
