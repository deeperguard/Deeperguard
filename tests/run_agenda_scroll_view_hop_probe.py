#!/usr/bin/env python3
"""Bounded probe: 390 / 3day / manual_scroll_after_view_hop (3 runs)."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ART = Path("/opt/cursor/artifacts/agenda-scroll-probe")
ART.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(ROOT / "tests"))
from run_agenda_view_matrix import ANCHOR_MON, free_port, start_server  # noqa: E402

from playwright.sync_api import sync_playwright

RUNS = 3


def probe_once(run_i: int) -> dict:
    from run_agenda_view_matrix import PERIOD_STATE  # noqa: E402

    data = Path(tempfile.mkdtemp(prefix=f"scroll-probe-{run_i}-"))
    port = free_port()
    proc = start_server(data, port)
    detail: dict = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True)
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            pw = "ProbePass1!x"
            page.fill('input[name="email"]', f"scroll-probe-{run_i}@e2e.invalid")
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
              const wed = new Date();
              const day = wed.getDay();
              const toMon = (day + 6) % 7;
              wed.setDate(wed.getDate() - toMon + 2);
              wed.setHours(8, 0, 0, 0);
              NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
                title: 'Audit Wed 08:00',
                start: wed.toISOString(),
                end: new Date(wed.getTime() + 3600000).toISOString(),
                all_day: false,
              });
              await NotesStore.flush();
              NotesAgenda.render();
              return { wed: wed.toISOString() };
            }"""
            )
            page.click("#app-tab-agenda")
            page.click('[data-agenda-view="3day"]')
            page.wait_for_timeout(400)
            st0 = page.evaluate("() => document.querySelector('.agenda-scroll-wrap')?.scrollTop")
            page.fill("#agenda-search", "Audit")
            page.wait_for_timeout(450)
            st1 = page.evaluate("() => document.querySelector('.agenda-scroll-wrap')?.scrollTop")
            page.fill("#agenda-search", "")
            page.wait_for_timeout(200)
            st2 = page.evaluate("() => document.querySelector('.agenda-scroll-wrap')?.scrollTop")
            page.click('[data-agenda-view="month"]')
            page.wait_for_timeout(350)
            page.click('[data-agenda-view="3day"]')
            page.evaluate(ANCHOR_MON, fx)
            wait_ms = 750
            page.wait_for_timeout(wait_ms)
            st3 = page.evaluate("() => document.querySelector('.agenda-scroll-wrap')?.scrollTop")
            wrap_h = page.evaluate(
                """() => {
              const w = document.querySelector('.agenda-scroll-wrap');
              return { client: w?.clientHeight, scroll: w?.scrollHeight, applying: w?.dataset?.agendaScrollApplying };
            }"""
            )
            detail = {
                "run": run_i,
                "st0": st0,
                "st1_search": st1,
                "st2_after_clear": st2,
                "st3_after_hop": st3,
                "delta": abs((st3 or 0) - (st2 or 0)),
                "ok": abs((st3 or 0) - (st2 or 0)) < 3,
                "wait_ms": wait_ms,
                "wrap": wrap_h,
            }
            browser.close()
    finally:
        proc.terminate()
    return detail


def main() -> int:
    runs = [probe_once(i) for i in range(RUNS)]
    out = {"runs": runs, "passes": sum(1 for r in runs if r.get("ok")), "total": RUNS}
    verdict = "harness_race" if any(not r.get("ok") for r in runs) and any(r.get("ok") for r in runs) else (
        "product" if all(not r.get("ok") for r in runs) else "ok"
    )
    out["verdict"] = verdict
    (ART / "view_hop_probe.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({"verdict": verdict, "passes": out["passes"], "total": RUNS}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
