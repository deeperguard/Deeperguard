#!/usr/bin/env python3
"""Diagnostic: 1280×800 / 3day / month→3day view hop (matrix manual_scroll_after_view_hop)."""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from run_agenda_view_matrix import (  # noqa: E402
    ANCHOR_MON,
    SEED_FIXTURE,
    free_port,
    start_server,
)

ART = Path("/opt/cursor/artifacts/agenda-scroll-diagnose")
ART.mkdir(parents=True, exist_ok=True)

SCROLL_TRACE_JS = """
() => {
  const wrap = document.querySelector('.agenda-scroll-wrap');
  const Core = globalThis.NotesAgendaScroll;
  const view = document.querySelector('.agenda-seg.is-active')?.getAttribute('data-agenda-view');
  const keys = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const k = sessionStorage.key(i);
    if (k && k.startsWith('notes_agenda_scroll')) keys.push(k);
  }
  const storage = {};
  keys.forEach((k) => { storage[k] = sessionStorage.getItem(k); });
  return {
    view,
    scrollTop: wrap?.scrollTop,
    scrollHeight: wrap?.scrollHeight,
    clientHeight: wrap?.clientHeight,
    applying: wrap?.dataset?.agendaScrollApplying,
    scrollKey: wrap?.dataset?.agendaScrollKey,
    layoutReady: Core?.isTimeGridLayoutReady
      ? Core.isTimeGridLayoutReady(wrap?.scrollHeight, wrap?.clientHeight)
      : null,
    storage,
  };
}
"""


def sample_trace(page, label: str, samples: list) -> None:
    samples.append({"t_ms": int(time.time() * 1000), "label": label, **page.evaluate(SCROLL_TRACE_JS)})


def main() -> int:
    from playwright.sync_api import sync_playwright

    data = Path(tempfile.mkdtemp(prefix="scroll-diag-"))
    port = free_port()
    proc = start_server(data, port)
    trace: list[dict] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            pw = "DiagPass1!x"
            page.fill('input[name="email"]', f"scroll-diag-{int(time.time())}@e2e.invalid")
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
            page.click('[data-agenda-view="3day"]')
            page.wait_for_timeout(500)
            sample_trace(page, "3day_initial", trace)
            page.fill("#agenda-search", "Audit")
            page.wait_for_timeout(450)
            page.fill("#agenda-search", "")
            page.wait_for_timeout(200)
            st2 = page.evaluate("() => document.querySelector('.agenda-scroll-wrap')?.scrollTop")
            sample_trace(page, "st2_before_hop", trace)
            page.click('[data-agenda-view="month"]')
            page.wait_for_timeout(350)
            sample_trace(page, "month", trace)
            page.click('[data-agenda-view="3day"]')
            page.evaluate(ANCHOR_MON, fx)
            for delay in (0, 50, 150, 400, 750, 1200):
                page.wait_for_timeout(delay if delay else 1)
                sample_trace(page, f"after_3day_return+{delay}ms", trace)
            st3 = page.evaluate("() => document.querySelector('.agenda-scroll-wrap')?.scrollTop")
            browser.close()
    finally:
        proc.terminate()

    out = {
        "viewport": "1280x800",
        "view": "3day",
        "saved_st2": st2,
        "restored_st3_750_window": st3,
        "matrix_ok": abs((st3 or 0) - (st2 or 0)) < 3,
        "trace": trace,
        "cause_note": (
            "Pre-fix: placeScroll ran with scrollHeight/clientHeight 0, "
            "clamp forced scrollTop=0 and rAF loop exited before relayout."
        ),
    }
    (ART / "view_hop_diagnose_1280_3day.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({"matrix_ok": out["matrix_ok"], "st2": st2, "st3": st3}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
