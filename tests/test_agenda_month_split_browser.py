"""Real-app Chromium test: draggable divider between the phone month grid and the day list.

Touch and mouse drags, keyboard, double tap/click reset, persistence (reload, month change,
lock/unlock) and clamping at 390x844 and a narrow desktop window, plus the unchanged wide
desktop month and week views. Skips without Chromium.
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

PASSWORD = "SplitPass1!abcd"
KEY = "notes_agenda_month_row_h"

SEED = """async () => {
  const d = new Date(2026, 10, 20);
  for (let h = 8; h < 14; h += 1) {
    const s = new Date(d); s.setHours(h, 0, 0, 0);
    const e = new Date(d); e.setHours(h + 1, 0, 0, 0);
    NotesStore.upsertAgendaEvent(NotesStore.newUuid(), { title: 'Event ' + h, start: s.toISOString(),
      end: e.toISOString(), all_day: false });
  }
  await NotesStore.flush();
}"""

MEASURE = """() => {
  const q = (s) => document.querySelector('#agenda-root ' + s);
  const cells = [...document.querySelectorAll('#agenda-root .agenda-month-cell')];
  const h = q('#agenda-month-split');
  const list = q('.agenda-month-daylist');
  const body = q('.agenda-body');
  return {
    rows: document.querySelectorAll('#agenda-root .agenda-month-row').length,
    rowH: cells[0].getBoundingClientRect().height,
    minCellH: Math.min(...cells.map((c) => c.getBoundingClientRect().height)),
    gridBottom: q('.agenda-month-grid').getBoundingClientRect().bottom,
    listH: list ? list.getBoundingClientRect().height : null,
    listTop: list ? list.getBoundingClientRect().top : null,
    listScroll: list ? list.scrollTop : null,
    bodyScroll: body.scrollTop, winScroll: scrollY,
    now: h ? Number(h.getAttribute('aria-valuenow')) : null,
    min: h ? Number(h.getAttribute('aria-valuemin')) : null,
    max: h ? Number(h.getAttribute('aria-valuemax')) : null,
    selection: String(getSelection()),
    stored: localStorage.getItem('notes_agenda_month_row_h'),
    inner: innerHeight,
  };
}"""


def unlock_if_needed(page):
    page.wait_for_function(
        "() => (typeof NotesStore !== 'undefined' && NotesStore.isUnlocked())"
        " || document.querySelector('#unlock-form input[autocomplete=\"current-password\"]')?.offsetParent",
        timeout=120_000)
    if page.evaluate("() => !NotesStore.isUnlocked()"):
        page.fill('#unlock-form input[autocomplete="current-password"]', PASSWORD)
        page.click("#unlock-submit")
        page.wait_for_function("() => NotesStore.isUnlocked()", timeout=120_000)
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-root .agenda-month-grid", timeout=30_000)


@pytest.fixture(scope="module")
def session():
    data = Path(tempfile.mkdtemp(prefix="dg-month-split-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
            ctx.add_init_script(
                "(() => { const R = Date; const off = new R(2026, 10, 20, 12).getTime() - R.now();"
                " class D extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); }"
                " static now() { return R.now() + off; } } window.Date = D; })();")
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "split@e2e.invalid")
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
            page.session_ctx = ctx
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _open(page, width, height):
    """Month view at the given size with the stored position cleared."""
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_function(
        "(phone) => { const b = document.getElementById('agenda-phone-more');"
        " return (!!b && b.getClientRects().length > 0) === phone; }",
        arg=width <= 768)
    page.evaluate("(k) => localStorage.removeItem(k)", KEY)
    if page.locator("#agenda-root .agenda-month-grid").count() == 0:
        toggle = page.locator('[data-agenda-view="month"]').locator("visible=true")
        if not toggle.count():
            page.click("#agenda-phone-more")
            page.wait_for_selector("#agenda-phone-menu", state="visible")
        toggle.first.click()
    page.evaluate("() => NotesAgenda.render()")
    page.wait_for_selector("#agenda-month-split")
    return page.evaluate(MEASURE)


def _handle_center(page):
    box = page.locator("#agenda-month-split").bounding_box()
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, box


def _touch_drag(page, dy, steps=6):
    cdp = page.session_ctx.new_cdp_session(page)
    x, y, _ = _handle_center(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent",
                 {"type": "touchMove", "touchPoints": [{"x": x, "y": y + dy * i / steps}]})
    page.wait_for_timeout(100)
    mid = page.evaluate(MEASURE)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()
    return mid, page.evaluate(MEASURE)


def test_handle_has_separator_semantics_and_44px_hit_area(session):
    m = _open(session, 390, 844)
    h = session.locator("#agenda-month-split")
    assert h.get_attribute("role") == "separator"
    assert h.get_attribute("aria-orientation") == "horizontal"
    assert h.get_attribute("aria-label")
    assert h.get_attribute("tabindex") == "0"
    assert h.bounding_box()["height"] >= 44
    assert m["min"] == 44 and m["min"] <= m["now"] <= m["max"], m
    assert session.evaluate("() => getComputedStyle(document.getElementById('agenda-month-split')).touchAction") == "none"
    assert session.evaluate(
        "() => getComputedStyle(document.querySelector('#agenda-root .agenda-month-daylist')).touchAction") != "none"


def test_touch_drag_resizes_rows_and_list(session):
    page = session
    before = _open(page, 390, 844)
    mid, down = _touch_drag(page, 60)
    # follows the finger: the list top moves with it, before release already
    assert mid["rowH"] > before["rowH"] and abs(mid["listTop"] - (before["listTop"] + 60)) <= 8, (before, mid)
    assert down["rowH"] > before["rowH"] and down["listH"] < before["listH"], (before, down)
    assert down["rows"] == 6 and down["minCellH"] >= 44, down
    assert down["bodyScroll"] == 0 and down["winScroll"] == 0 and down["selection"] == "", down
    assert down["stored"] == str(down["now"])
    _, up = _touch_drag(page, -400)
    assert up["rowH"] == 44 and up["minCellH"] >= 44 and up["rows"] == 6, up
    assert up["listH"] > down["listH"], (down, up)
    _, tall = _touch_drag(page, 800)
    assert tall["rowH"] == tall["max"] > up["rowH"], tall
    assert tall["listH"] >= 160 and tall["gridBottom"] <= tall["inner"] - 160, tall
    assert tall["winScroll"] == 0 and tall["bodyScroll"] == 0, tall


def test_list_scrolls_after_release(session):
    page = session
    _open(page, 390, 700)
    page.keyboard.press("Tab")  # keep focus out of the way of the wheel test
    page.evaluate("() => document.getElementById('agenda-month-split').focus()")
    page.keyboard.press("Home")
    page.mouse.move(195, 640)
    page.mouse.wheel(0, 300)
    page.wait_for_function(
        "() => document.querySelector('#agenda-root .agenda-month-daylist').scrollTop > 0")


def test_mouse_drag_at_narrow_desktop_window(session):
    page = session
    before = _open(page, 700, 900)
    x, y, _ = _handle_center(page)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, y + 30, steps=5)
    page.mouse.move(x, y + 60, steps=5)
    page.wait_for_timeout(100)
    mid = page.evaluate(MEASURE)
    page.mouse.up()
    after = page.evaluate(MEASURE)
    assert mid["rowH"] > before["rowH"] and after["rowH"] == mid["rowH"], (before, mid, after)
    assert after["listH"] < before["listH"] and after["rows"] == 6 and after["minCellH"] >= 44, after
    assert after["selection"] == "" and after["winScroll"] == 0, after
    x, y, _ = _handle_center(page)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, y - 500, steps=8)
    page.mouse.up()
    assert page.evaluate(MEASURE)["rowH"] == 44


def test_keyboard(session):
    page = session
    m = _open(page, 390, 844)
    page.focus("#agenda-month-split")
    page.keyboard.press("ArrowDown")
    n1 = page.evaluate(MEASURE)
    assert n1["now"] == m["now"] + 4 and n1["rowH"] == n1["now"], (m, n1)
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowUp")
    assert page.evaluate(MEASURE)["now"] == m["now"] + 4
    page.keyboard.press("Home")
    lo = page.evaluate(MEASURE)
    assert lo["now"] == lo["min"] == 44 and lo["rowH"] == 44
    page.keyboard.press("ArrowUp")
    assert page.evaluate(MEASURE)["now"] == 44, "never below the minimum"
    page.keyboard.press("End")
    hi = page.evaluate(MEASURE)
    assert hi["now"] == hi["max"] and hi["rowH"] == hi["max"] > 44 and hi["listH"] >= 160, hi
    page.keyboard.press("ArrowDown")
    assert page.evaluate(MEASURE)["now"] == hi["max"], "never above the maximum"
    assert session.evaluate("() => document.activeElement.id") == "agenda-month-split"


def test_double_click_and_double_tap_restore_default(session):
    page = session
    m = _open(page, 390, 844)
    page.focus("#agenda-month-split")
    page.keyboard.press("End")
    assert page.evaluate(MEASURE)["now"] > m["now"]
    x, y, _ = _handle_center(page)
    page.mouse.dblclick(x, y)
    d = page.evaluate(MEASURE)
    assert d["now"] == m["now"] and d["stored"] is None, d
    page.keyboard.press("End")
    x, y, _ = _handle_center(page)
    page.touchscreen.tap(x, y)
    page.touchscreen.tap(x, y)
    d = page.evaluate(MEASURE)
    assert d["now"] == m["now"] and d["stored"] is None, d
    page.wait_for_timeout(500)  # the release click must not open the event row now under the finger
    assert not page.evaluate("() => !!document.getElementById('agenda-editor')?.offsetParent")


def test_position_survives_month_change_reload_and_lock(session):
    page = session
    _open(page, 390, 844)
    page.focus("#agenda-month-split")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    want = page.evaluate(MEASURE)["now"]
    page.click("#agenda-next")
    page.wait_for_selector("#agenda-month-split")
    assert page.evaluate(MEASURE)["now"] == want
    page.click("#agenda-prev")
    page.evaluate("() => document.getElementById('btn-lock-now').click()")
    page.wait_for_selector("#unlock-form", state="visible", timeout=30_000)
    unlock_if_needed(page)
    page.wait_for_selector("#agenda-month-split")
    assert page.evaluate(MEASURE)["now"] == want
    page.reload()
    unlock_if_needed(page)
    page.wait_for_selector("#agenda-month-split")
    m = page.evaluate(MEASURE)
    assert m["now"] == want and m["rowH"] == want and m["stored"] == str(want), m


def test_stored_value_is_clamped_not_discarded(session):
    page = session
    _open(page, 390, 844)
    page.evaluate("(k) => localStorage.setItem(k, '900')", KEY)
    page.evaluate("() => NotesAgenda.render()")
    big = page.evaluate(MEASURE)
    assert big["now"] == big["max"] < 900 and big["listH"] >= 160, big
    page.evaluate("(k) => localStorage.setItem(k, '10')", KEY)
    page.evaluate("() => NotesAgenda.render()")
    assert page.evaluate(MEASURE)["now"] == 44
    # A tall stored value on a short screen (rotation): clamped now, the stored value
    # is kept and applies again when the screen is tall again.
    page.evaluate("(k) => localStorage.setItem(k, '80')", KEY)
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("() => NotesAgenda.render()")
    tall = page.evaluate(MEASURE)
    page.set_viewport_size({"width": 390, "height": 560})
    page.wait_for_function("(v) => Number(document.getElementById('agenda-month-split')"
                           ".getAttribute('aria-valuenow')) < v", arg=tall["now"])
    short = page.evaluate(MEASURE)
    assert short["now"] == short["max"] and short["stored"] == "80", short
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_function("(v) => Number(document.getElementById('agenda-month-split')"
                           ".getAttribute('aria-valuenow')) === v", arg=tall["now"])


def test_wide_desktop_month_and_week_view_have_no_divider(session):
    page = session
    _open(page, 390, 844)
    page.set_viewport_size({"width": 1280, "height": 800})
    page.wait_for_function("() => !document.getElementById('agenda-month-split')")
    assert page.locator("#agenda-root .agenda-month-grid").count() == 1
    assert page.locator("#agenda-root .agenda-month-daylist").count() == 0
    page.click('[data-agenda-view="week"]')
    page.wait_for_selector("#agenda-root .agenda-week-layout")
    assert page.locator("#agenda-month-split").count() == 0
    page.click('[data-agenda-view="month"]')
