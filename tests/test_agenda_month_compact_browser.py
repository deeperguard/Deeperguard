"""Real-app Chromium test: compact phone month grid with its own scrolling day list.

Seeds six events on 2026-11-20 (a month that spans six week rows) and measures
the grid and the day list at phone sizes and the unchanged 1280px desktop grid.
Skips without Chromium.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

PASSWORD = "CompactPass1!abc"

SEED = """async () => {
  const d = new Date(2026, 10, 20);
  const at = (h) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; };
  for (let h = 8; h < 14; h += 1) {
    NotesStore.upsertAgendaEvent(NotesStore.newUuid(), { title: 'Event ' + h, start: at(h).toISOString(),
      end: at(h + 1).toISOString(), all_day: false });
  }
  await NotesStore.flush();
}"""

MEASURE = """() => {
  const q = (s) => document.querySelector('#agenda-root ' + s);
  const rows = [...document.querySelectorAll('#agenda-root .agenda-month-row')];
  const cells = [...document.querySelectorAll('#agenda-root .agenda-month-cell')];
  const grid = q('.agenda-month-grid').getBoundingClientRect();
  const list = q('.agenda-month-daylist');
  const lr = list ? list.getBoundingClientRect() : null;
  const items = list ? [...list.querySelectorAll('.agenda-list-row')] : [];
  const visible = items.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= lr.top - 0.5 && r.bottom <= Math.min(lr.bottom, innerHeight) + 0.5;
  }).length;
  const fab = document.getElementById('agenda-fab-add');
  const fr = fab && fab.getClientRects().length ? fab.getBoundingClientRect() : null;
  const dots = cells.map((c) => c.querySelector('.agenda-month-events').getBoundingClientRect().top
    - c.querySelector('.agenda-month-date').getBoundingClientRect().bottom);
  return {
    rows: rows.length, rowH: rows[0].getBoundingClientRect().height,
    minCellH: Math.min(...cells.map((c) => c.getBoundingClientRect().height)),
    minCellW: Math.min(...cells.map((c) => c.getBoundingClientRect().width)),
    gridTop: q('.agenda-month-head').getBoundingClientRect().top, gridBottom: grid.bottom,
    listTop: lr ? lr.top : null, listBottom: lr ? lr.bottom : null, visible, total: items.length,
    listScrollable: list ? list.scrollHeight > list.clientHeight + 1 : false,
    overflow: list ? getComputedStyle(list).overflowY : null,
    docScroll: document.scrollingElement.scrollHeight - innerHeight,
    fabTop: fr ? fr.top : null,
    lastBottom: items.length ? items[items.length - 1].getBoundingClientRect().bottom : null,
    minDotGap: Math.min(...dots),
    weekNums: document.querySelectorAll('#agenda-root .agenda-month-week').length,
    dotCount: document.querySelectorAll('#agenda-root .agenda-month-dot').length,
  };
}"""


@pytest.fixture(scope="module")
def session():
    data = Path(tempfile.mkdtemp(prefix="dg-month-compact-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            ctx = browser.new_context(viewport={"width": 390, "height": 844})
            ctx.add_init_script(
                "(() => { const R = Date; const off = new R(2026, 10, 20, 12).getTime() - R.now();"
                " class D extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); }"
                " static now() { return R.now() + off; } } window.Date = D; })();")
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "compact@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            page.evaluate(SEED)
            page.click("#app-tab-agenda")
            page.wait_for_selector("#agenda-root [data-agenda-id]", timeout=30_000)
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _month(page, width, height):
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_function(
        "(phone) => { const b = document.getElementById('agenda-phone-more');"
        " return (!!b && b.getClientRects().length > 0) === phone; }",
        arg=width <= 768,
    )
    if page.locator("#agenda-root .agenda-month-grid").count() == 0:
        toggle = page.locator('[data-agenda-view="month"]').locator("visible=true")
        if not toggle.count():
            page.click("#agenda-phone-more")
            page.wait_for_selector("#agenda-phone-menu", state="visible")
        toggle.first.click()
    page.wait_for_selector("#agenda-root .agenda-month-grid")
    return page.evaluate(MEASURE)


@pytest.mark.parametrize("width,height", [(390, 844), (360, 740), (700, 360)])
def test_phone_month_is_compact(session, width, height):
    m = _month(session, width, height)
    print("MEASURED", width, height, m)
    assert m["rows"] == 6
    assert 44 <= m["rowH"] <= 56, m
    assert m["minCellH"] >= 44 and m["minCellW"] >= 40, m
    assert m["weekNums"] == 6 and m["dotCount"] >= 6, m
    assert m["minDotGap"] >= 0, "dots must not overlap the day number"
    assert m["docScroll"] <= 1, m
    assert m["listTop"] <= m["gridBottom"] + 2, "day list directly follows the grid"
    assert m["overflow"] in ("auto", "scroll"), "the day list is its own scroll area"
    if height > width:
        assert m["gridBottom"] - m["gridTop"] <= 0.45 * height, m
    if (width, height) == (390, 844):
        assert m["visible"] >= 4, m
        assert m["listTop"] <= 677 - 250, m  # list started at y=677 before the compact rows


def test_list_scrolls_and_fab_does_not_cover_last_event(session):
    page = session
    _month(page, 360, 740)
    top = page.evaluate("() => document.querySelector('#agenda-root .agenda-month-grid').getBoundingClientRect().top")
    page.evaluate("() => { const l = document.querySelector('#agenda-root .agenda-month-daylist'); l.scrollTop = l.scrollHeight; }")
    m = page.evaluate(MEASURE)
    assert m["listScrollable"], m
    assert page.evaluate("() => document.querySelector('#agenda-root .agenda-month-grid').getBoundingClientRect().top") == top
    assert m["fabTop"] is not None and m["lastBottom"] <= m["fabTop"] + 0.5, m


def test_tap_day_selects_and_updates_list(session):
    page = session
    _month(page, 390, 844)
    page.click('#agenda-root .agenda-month-cell:not(.is-out) .agenda-month-date >> text="19"')
    page.wait_for_selector("#agenda-root .agenda-month-daylist .agenda-month-daylist-empty")
    assert page.locator("#agenda-root .agenda-month-cell.is-pick").count() == 1
    page.click('#agenda-root .agenda-month-cell:not(.is-out) .agenda-month-date >> text="20"')
    page.wait_for_selector("#agenda-root .agenda-month-daylist .agenda-list-row")
    assert page.locator("#agenda-root .agenda-month-daylist .agenda-list-row").count() == 6


def test_desktop_month_unchanged(session):
    m = _month(session, 1280, 800)
    assert m["weekNums"] == 0
    assert m["rowH"] >= 88, "desktop cells keep their height"
    assert m["listTop"] is None
