"""Real-app Chromium test: phone month grid grip (fold to the week), swipe and kept day.

Reuses the session fixture of the divider test (390x844, clock fixed at 2026-11-20). Skips without Chromium.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from test_agenda_month_split_browser import _open, session  # noqa: E402,F401

ROWS = "() => document.querySelectorAll('#agenda-root .agenda-month-row').length"
PICK = "() => document.querySelector('#agenda-root .agenda-month-cell.is-pick')?.getAttribute('data-agenda-month-day')"
MS = "([y, m, d]) => String(new Date(y, m, d).getTime())"


def _swipe(page, dx, dy):
    cdp = page.session_ctx.new_cdp_session(page)
    box = page.locator("#agenda-root .agenda-month-grid").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + 60
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, 7):
        cdp.send("Input.dispatchTouchEvent",
                 {"type": "touchMove", "touchPoints": [{"x": x + dx * i / 6, "y": y + dy * i / 6}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()
    page.wait_for_timeout(200)


def _select(page, y, m, d):
    page.evaluate(
        "([y, m, d]) => { const s = NotesAgenda._state; s.monthCollapsed = false;"
        " s.anchor = new Date(y, m, d); s.monthPickDay = new Date(y, m, d).getTime(); NotesAgenda.render(); }",
        [y, m, d])


def test_grip_folds_to_week_by_keyboard_and_back(session):
    page = session
    _open(page, 390, 844)
    _select(page, 2026, 10, 18)
    grip = page.locator("#agenda-month-grip")
    assert grip.get_attribute("aria-expanded") == "true"
    assert grip.get_attribute("aria-label") == "Collapse month"
    assert page.evaluate(ROWS) == 6
    grip.focus()
    page.keyboard.press("Enter")
    assert page.evaluate(ROWS) == 1
    assert page.evaluate(PICK) == page.evaluate(MS, [2026, 10, 18])
    grip = page.locator("#agenda-month-grip")
    assert grip.get_attribute("aria-expanded") == "false"
    assert grip.get_attribute("aria-label") == "Expand month"
    assert page.evaluate("() => document.activeElement.id") == "agenda-month-grip"
    page.keyboard.press("Space")
    assert page.evaluate(ROWS) == 6
    assert page.locator("#agenda-month-grip").get_attribute("aria-expanded") == "true"


def test_grip_drag_up_folds_and_down_unfolds(session):
    page = session
    _open(page, 390, 844)
    _select(page, 2026, 10, 18)
    for dy, rows in ((-40, 1), (40, 6)):
        box = page.locator("#agenda-month-grip").bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x, y + dy, steps=4)
        page.mouse.up()
        assert page.evaluate(ROWS) == rows


def test_swipe_changes_month_or_week_and_keeps_day(session):
    page = session
    _open(page, 390, 844)
    _select(page, 2027, 0, 31)
    _swipe(page, -150, 5)  # to the left: next month
    assert page.evaluate(PICK) == page.evaluate(MS, [2027, 1, 28])
    _swipe(page, 150, 5)  # to the right: previous month
    assert page.evaluate(PICK) == page.evaluate(MS, [2027, 0, 28])
    page.locator("#agenda-month-grip").focus()
    page.keyboard.press("Enter")
    assert page.evaluate(ROWS) == 1
    _swipe(page, -150, 5)  # folded: next week
    assert page.evaluate(PICK) == page.evaluate(MS, [2027, 1, 4])
    assert page.evaluate(ROWS) == 1
    # the existing previous button also steps by week while folded
    page.click("#agenda-prev")
    assert page.evaluate(PICK) == page.evaluate(MS, [2027, 0, 28])


def test_vertical_or_short_drag_is_not_a_swipe(session):
    page = session
    _open(page, 390, 844)
    _select(page, 2026, 10, 18)
    before = page.evaluate(PICK)
    _swipe(page, 20, 0)  # too short
    _swipe(page, 60, 120)  # mostly vertical
    assert page.evaluate(PICK) == before
